import { randomUUID } from "node:crypto";
import { Clock, Effect, Result } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Session } from "@opencode/schema/session";
import { bindUsageSessions } from "../usage/schema.ts";
import { SessionMessage } from "@opencode/schema/session-message";
import type { PersonaRuntime } from "../opencode/runtime.ts";
import type { Messages } from "@ren-ai/imsg";
import { conversationStarted } from "../transcript/transcript.ts";
import { withLifecycle } from "../conversations/lifecycle.ts";
import type { conversations } from "../conversations/conversations.ts";
import { contactCause, contactLog } from "./diagnostics.ts";
import type { ContactLog } from "./diagnostics.ts";
import { claimWork, workBatchSize } from "../work-budget.ts";
import type { DiscoveryRequest, StartingRelationship } from "@ren-ai/onboarding";
import { contactOutcome } from "../metrics/conversations.ts";

interface Contact {
  id: string;
  handle: string;
  personaID: string;
  sessionID: string | null;
  state: string;
  startedAt: number | null;
  requestId: string;
  locale: string;
  conversationLanguage: string | null;
  startingRelationship: StartingRelationship | null;
  imageStyle: NonNullable<DiscoveryRequest["imageStyle"]>;
  name: string | null;
  age: number | null;
  gender: string | null;
  consentVersion: string;
  consentAt: number;
}

export const firstContacts = (
  host: PersonaRuntime,
  messages: Pick<Messages, "textStatus">,
  directory: Pick<Effect.Success<typeof conversations>, "withHandle">,
  model: string,
  log: ContactLog = contactLog,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const unavailable = (handle: string) =>
      Effect.map(
        sql`SELECT 1 FROM blocked WHERE handle = ${handle}
    UNION SELECT 1 FROM removal WHERE handle = ${handle}
    UNION SELECT 1 FROM reset WHERE handle = ${handle} AND complete = 0`,
        (rows) => rows.length > 0,
      );
    const countOutcome =
      (state: Parameters<typeof contactOutcome>[1]) => (rows: readonly { id: string }[]) =>
        Effect.forEach(rows, (row) => contactOutcome(row.id, state)).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
    const transition = (id: string, state: Parameters<typeof contactOutcome>[1]) =>
      sql<{
        id: string;
      }>`UPDATE discovery_contact SET state = ${state} WHERE registration_id = ${id} AND state != ${state} RETURNING registration_id AS id`.pipe(
        Effect.tap(countOutcome(state)),
      );
    const update = (...args: Parameters<typeof transition>) =>
      transition(...args).pipe(sql.withTransaction);
    const start = (row: Contact) =>
      Effect.gen(function* () {
        const persona = host.personas.get(row.personaID);
        const sessionID = Session.ID.create();
        const claimed = yield* Effect.gen(function* () {
          if (!persona?.published || (yield* unavailable(row.handle))) {
            yield* transition(row.id, "blocked");
            return false;
          }
          const changed =
            yield* sql`UPDATE discovery_contact SET state = 'preparing', session_id = ${sessionID}
        WHERE registration_id = ${row.id} AND state = 'scheduled' RETURNING registration_id`;
          return changed.length > 0;
        }).pipe(sql.withTransaction, withLifecycle);
        if (!claimed) return;
        let stage = "session.create";
        let createdID = sessionID;
        const began = performance.now();
        log({
          requestId: row.requestId,
          operation: "discovery.firstContact",
          model,
          stage,
          personaId: row.personaID,
          outcome: "started",
          level: "info",
          durationMs: 0,
        });
        const execution = Effect.gen(function* () {
          const session = yield* host.createSession(row.personaID, sessionID, sessionID);
          createdID = session.id;
          const now = yield* Clock.currentTimeMillis;
          stage = "conversation.commit";
          const bound = yield* Effect.gen(function* () {
            if (yield* unavailable(row.handle)) {
              yield* transition(row.id, "blocked");
              return false;
            }
            const current =
              yield* sql`SELECT 1 FROM discovery_registration WHERE id = ${row.id} AND archived_at IS NULL`;
            if (!current.length) return false;
            yield* sql`INSERT INTO user (handle, locale, consent_version, consent_language, consent_at, persona_id, joined_at)
          VALUES (${row.handle}, ${row.locale}, ${row.consentVersion}, ${row.locale}, ${row.consentAt}, ${row.personaID}, ${now})
          ON CONFLICT(handle) DO UPDATE SET locale = excluded.locale,
            persona_id = excluded.persona_id, joined_at = COALESCE(user.joined_at, excluded.joined_at)`;
            yield* sql`INSERT INTO conversation (user_id, persona_id, session_id, usage_key, started_at, registration_id, starting_relationship, image_style)
          VALUES ((SELECT id FROM user WHERE handle = ${row.handle}), ${row.personaID}, ${session.id}, ${sessionID}, ${now}, ${row.id}, ${row.startingRelationship}, ${row.imageStyle})`;
            yield* bindUsageSessions(sql);
            yield* sql`UPDATE discovery_contact SET session_id = ${session.id}, started_at = ${now}, state = 'greeting' WHERE registration_id = ${row.id}`;
            return true;
          }).pipe(sql.withTransaction, withLifecycle);
          if (!bound) {
            yield* host.sessions.remove(session.id);
            return;
          }
          stage = "greeting.enqueue";
          yield* host.sessions.prompt({
            sessionID: session.id,
            id: SessionMessage.ID.make(`msg_discovery_${row.id}`),
            text: conversationStarted(
              now,
              persona!.openingLine,
              persona!.timeZone,
              row.conversationLanguage ?? undefined,
              row,
              row.startingRelationship ?? undefined,
            ),
          });
        });
        const outcome = yield* Effect.result(execution);
        if (Result.isFailure(outcome)) {
          log({
            requestId: row.requestId,
            operation: "discovery.firstContact",
            model,
            stage,
            personaId: row.personaID,
            outcome: "failed",
            level: "error",
            durationMs: performance.now() - began,
            ...contactCause(outcome.failure),
          });
          yield* sql<{
            id: string;
          }>`UPDATE discovery_contact SET state = 'review' WHERE registration_id = ${row.id} AND state IN ('preparing','greeting') RETURNING registration_id AS id`.pipe(
            Effect.tap(countOutcome("review")),
            sql.withTransaction,
          );
        }
        if (Result.isFailure(outcome) && stage === "conversation.commit") {
          const id = createdID;
          const cleanup = yield* Effect.result(
            Effect.gen(function* () {
              const referenced = yield* sql`SELECT 1 FROM conversation WHERE session_id = ${id}`;
              if (!referenced.length) yield* host.sessions.remove(id);
            }),
          );
          if (Result.isFailure(cleanup))
            log({
              requestId: row.requestId,
              operation: "discovery.sessionCleanup",
              model,
              stage: "session.cleanup",
              outcome: "failed",
              level: "error",
              durationMs: performance.now() - began,
              ...contactCause(cleanup.failure),
            });
        }
        log({
          requestId: row.requestId,
          operation: "discovery.firstContact",
          model,
          stage: "task",
          personaId: row.personaID,
          outcome: Result.isFailure(outcome) ? "failed" : "completed",
          level: "info",
          durationMs: performance.now() - began,
        });
      });
    const observe = (row: Contact) =>
      Effect.gen(function* () {
        if (yield* unavailable(row.handle)) {
          yield* update(row.id, "blocked");
          return;
        }
        if (!row.sessionID) {
          yield* update(row.id, "review");
          return;
        }
        const [send] = yield* sql<{
          state: string;
          at: number;
        }>`SELECT send.state, send.recorded_at AS at
      FROM send JOIN conversation ON conversation.id = send.conversation_id
       WHERE conversation.session_id = ${row.sessionID} AND send.kind = 'text' AND send.state != 'not_sent'
       ORDER BY CASE WHEN send.state IN ('sent', 'delivered') THEN 0 ELSE 1 END, send.id LIMIT 1`;
        if (send) {
          if (send.state === "sent" || send.state === "delivered") yield* update(row.id, "active");
          else if (send.state === "failed") {
            const status = yield* messages.textStatus(row.handle, send.at);
            yield* update(row.id, status === "no_imessage" ? "unreachable" : "failed");
          } else yield* update(row.id, "review");
          return;
        }
        const session = yield* host.sessions.get(Session.ID.make(row.sessionID));
        if (session.outcome === "failed" || session.outcome === "succeeded")
          yield* update(row.id, "failed");
      });
    const tick = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const limit = yield* workBatchSize;
      const rows =
        yield* sql<Contact>`SELECT r.id, r.handle, r.locale, l.conversation_language AS conversationLanguage, r.consent_version AS consentVersion,
      r.created_at AS consentAt, c.persona_id AS personaID, c.session_id AS sessionID, c.state,
        c.started_at AS startedAt, c.request_id AS requestId, p.name, p.age, p.gender,
        r.starting_relationship AS startingRelationship, r.image_style AS imageStyle
       FROM discovery_contact c JOIN discovery_registration r ON r.id = c.registration_id
        LEFT JOIN discovery_language l ON l.registration_id = r.id
        LEFT JOIN discovery_profile p ON p.registration_id = r.id
        WHERE r.archived_at IS NULL AND c.state IN ('scheduled','preparing','greeting','review')
        AND ((c.state = 'scheduled' AND c.scheduled_at <= ${now}) OR c.state IN ('preparing','greeting','review')) ORDER BY c.last_checked, c.scheduled_at, c.registration_id LIMIT ${limit}`;
      for (const row of rows) {
        if (!(yield* claimWork)) break;
        yield* sql`UPDATE discovery_contact SET last_checked = (SELECT COALESCE(MAX(last_checked), 0) + 1 FROM discovery_contact
          WHERE state IN ('scheduled','preparing','greeting','review')) WHERE registration_id = ${row.id}`;
        const result = yield* Effect.result(
          directory.withHandle(row.handle)(row.state === "scheduled" ? start(row) : observe(row)),
        );
        if (Result.isFailure(result)) {
          const changed = yield* sql<{
            id: string;
          }>`UPDATE discovery_contact SET state = 'review' WHERE registration_id = ${row.id} AND state != 'review' RETURNING registration_id AS id`.pipe(
            Effect.tap(countOutcome("review")),
            sql.withTransaction,
          );
          if (changed.length)
            log({
              requestId: row.requestId,
              operation: "discovery.firstContact",
              model,
              stage: "task.observe",
              outcome: "failed",
              level: "error",
              durationMs: 0,
              ...contactCause(result.failure),
            });
        }
      }
    }).pipe(
      Effect.tapError((failure) =>
        Effect.sync(() =>
          log({
            requestId: randomUUID(),
            operation: "discovery.firstContact",
            model,
            stage: "queue.read",
            outcome: "failed",
            level: "error",
            durationMs: 0,
            ...contactCause(failure),
          }),
        ),
      ),
    );
    return { tick };
  });
