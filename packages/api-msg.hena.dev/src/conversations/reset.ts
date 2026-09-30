import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import type { conversations } from "./conversations.ts";
import type { PersonaRuntime } from "../opencode/runtime.ts";
import type { IncomingMessage, Messages } from "../messages/messages.ts";
import { conversationStarted, timestamp } from "../transcript/transcript.ts";
import { retainedSessions } from "./retained.ts";
import { resetBoundary } from "./reset-boundary.ts";

export const resets = (
  directory: Effect.Success<typeof conversations>,
  host: PersonaRuntime,
  notice: Readonly<Record<"ko", string>>,
  sendNotice: (handle: string, text: string) => Effect.Effect<void, Error>,
  forget: (sessionID: string) => Effect.Effect<void>,
  messages: Messages,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const retained = yield* retainedSessions(host);
    const beforeReset = yield* resetBoundary(messages);
    const finish = (guid: string) =>
      Effect.gen(function* () {
        const [pending] = yield* sql<{
          id: number;
          handle: string;
          sessionID: string;
          personaID: string;
          date: number;
        }>`
          SELECT conversation.id, user.handle, conversation.session_id AS sessionID, conversation.persona_id AS personaID, reset.date
      FROM reset JOIN conversation ON conversation.reset_guid = reset.guid
      JOIN user ON user.id = conversation.user_id WHERE reset.guid = ${guid} AND reset.complete = 0`;
        if (!pending) return;
        const persona = host.personas.get(pending.personaID)!;
        yield* retained.resume;
        const session = yield* host.sessions.get(Session.ID.make(pending.sessionID)).pipe(
          Effect.catchTag("Session.NotFoundError", () =>
            Effect.gen(function* () {
              const replacement = yield* host.createSession(pending.personaID);
              yield* directory.replaceSession(pending, replacement.id);
              yield* directory.rebuilt({ ...pending, sessionID: replacement.id });
              return replacement;
            }),
          ),
        );
        const rows = yield* messages.recent(pending.handle, pending.date);
        const boundary = rows.findIndex((row) => row.guid === guid);
        if (!rows.slice(boundary + 1).some((row) => row.fromMe && row.text === notice.ko))
          yield* sendNotice(pending.handle, notice.ko);
        yield* host.sessions.prompt({
          sessionID: session.id,
          id: SessionMessage.ID.make(`msg_onboarding_${session.id}`),
          text: conversationStarted(pending.date, persona.openingLine, notice.ko, persona.timeZone),
        });
        yield* sql`UPDATE reset SET complete = 1 WHERE guid = ${guid}`;
      });
    const receive = (row: IncomingMessage) =>
      Effect.gen(function* () {
        if (row.fromMe || row.tapback || row.text.trim().toLowerCase() !== "/reset") return;
        yield* directory.withHandle(row.handle)(
          Effect.gen(function* () {
            const known = yield* sql`SELECT 1 FROM reset WHERE guid = ${row.guid}`;
            if (known.length) {
              yield* finish(row.guid);
              return;
            }
            if ((yield* sql`SELECT 1 FROM intake_seen WHERE guid = ${row.guid}`).length) return;
            if (yield* beforeReset(row)) return;
            const allowed = yield* sql`SELECT 1 FROM test_handle WHERE handle = ${row.handle}`;
            if (!allowed.length) return;
            const conversation = yield* directory.byHandle(row.handle);
            if (!conversation) return;
            const persona = host.personas.get(conversation.personaID)!;
            const fresh = yield* host.createSession(conversation.personaID);
            const oldID = Session.ID.make(conversation.sessionID);
            const title = `${persona.id[0]!.toUpperCase()}${persona.id.slice(1)} · ${row.handle} · reset ${timestamp(row.createdAt, persona.timeZone)}`;
            yield* Effect.gen(function* () {
              yield* sql`INSERT INTO retained_session (session_id, handle, title)
        VALUES (${oldID}, ${row.handle}, ${title})`;
              yield* sql`INSERT INTO reset (guid, handle, row_id, date, session_id)
        VALUES (${row.guid}, ${row.handle}, ${row.id}, ${row.createdAt}, ${fresh.id})`;
              yield* sql`UPDATE conversation SET session_id = ${fresh.id}, reset_guid = ${row.guid},
        started_at = ${row.createdAt}, last_received_at = NULL WHERE id = ${conversation.id}`;
              yield* sql`UPDATE send SET conversation_id = NULL WHERE conversation_id = ${conversation.id}`;
              yield* sql`INSERT INTO follow_up (conversation_id, last_sent_at) VALUES (${conversation.id}, ${row.createdAt})
        ON CONFLICT(conversation_id) DO UPDATE SET last_sent_at = excluded.last_sent_at,
          next_wake_at = NULL, unanswered = 0, wake_pending = 0, followed_up = 0`;
            }).pipe(sql.withTransaction);
            yield* forget(oldID);
            yield* finish(row.guid);
          }),
        );
      });
    const resume = Effect.gen(function* () {
      for (const row of yield* sql<{ guid: string }>`SELECT guid FROM reset WHERE complete = 0`)
        yield* finish(row.guid);
    });
    return { receive, resume };
  });
