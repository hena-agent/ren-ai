import { Session } from "@opencode/schema/session";
import type { SessionMessage } from "@opencode/schema/session-message";
import { Clock, DateTime, Effect, Option, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { PersonaRuntime } from "./runtime.ts";
import type { Conversation, conversations } from "../conversations/conversations.ts";
import { recoveryBatch } from "./recovery-batch.ts";

type Directory = Effect.Success<typeof conversations>;
type Failure = {
  session_id: string;
  fingerprint: string;
  failures: number;
  quota: number;
  failed_at: number;
  retry_at: number;
  last_retry_at: number;
  review: number;
  provider_alerted: number;
};

export interface FailureAlerts {
  readonly raise: (name: string, detail?: string) => Effect.Effect<void>;
  readonly clear: (name: string) => Effect.Effect<void>;
}

const cap = "go-cap";
const provider = "provider-failing";
const turnAlert = (id: string) => `conversation-turn-failing:${id}`;
const probeDelay = 15 * 60_000;
const retryDelay = (failures: number) => Math.min(2 ** (failures - 1), 900) * 1000;
const quotaError = (assistant: SessionMessage.Info | undefined) =>
  assistant?.type === "assistant" && /quota/i.test(assistant.error?.type ?? "");
const resume = (host: PersonaRuntime, directory: Directory, sessionID: string) =>
  directory.admit(
    sessionID,
    host.retry(Session.ID.make(sessionID)).pipe(Effect.catchCause(Effect.logWarning)),
  );

/** Finite heartbeat reconciliation; all deadlines and probe rotation survive actor replacement. */
export const failedTurns = (
  host: PersonaRuntime,
  directory: Directory,
  alerts: FailureAlerts,
  eager = true,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const lock = yield* Semaphore.make(1);
    const pending = () => sql<Failure>`SELECT * FROM failed_turn WHERE review = 0
      ORDER BY retry_at, last_retry_at, failed_at, session_id`;

    const forget = (sessionID: string) =>
      Effect.gen(function* () {
        const removed =
          yield* sql<Failure>`DELETE FROM failed_turn WHERE session_id = ${sessionID} RETURNING *`;
        yield* alerts.clear(turnAlert(sessionID));
        const [active] = yield* sql<{ quota: number; provider: number }>`SELECT
          EXISTS(SELECT 1 FROM failed_turn WHERE review = 0 AND quota = 1) AS quota,
          EXISTS(SELECT 1 FROM failed_turn WHERE review = 0 AND quota = 0) AS provider`;
        if (removed.some((row) => row.quota) && !active!.quota) yield* alerts.clear(cap);
        if (removed.some((row) => !row.quota) && !active!.provider) yield* alerts.clear(provider);
      }).pipe(Effect.catchCause(Effect.logWarning));

    const succeeded = (prior: Failure) =>
      Effect.gen(function* () {
        const released = prior.quota ? yield* pending() : [];
        yield* forget(prior.session_id);
        if (prior.quota) {
          yield* sql`DELETE FROM failed_turn WHERE quota = 1 AND review = 0`;
          yield* alerts.clear(cap);
        }
        return released
          .filter((row) => row.session_id !== prior.session_id)
          .map((row) => row.session_id);
      });

    const record = (
      conversation: Conversation,
      fingerprint: string,
      assistant: SessionMessage.Info | undefined,
      prior: Failure | undefined,
      now: number,
    ) =>
      Effect.gen(function* () {
        const sessionID = conversation.sessionID;
        const outgoing = yield* sql`SELECT 1 FROM send WHERE conversation_id = ${conversation.id}
        AND kind IN ('text', 'tapback') LIMIT 1`;
        if (prior?.fingerprint === fingerprint && (!outgoing.length || prior.review)) return;
        const [held] = yield* sql<Failure>`SELECT * FROM failed_turn WHERE review = 0 AND quota = 1
          ORDER BY retry_at, last_retry_at, failed_at, session_id LIMIT 1`;
        const quota = Boolean(held) || quotaError(assistant);
        const failures = (prior?.failures ?? 0) + 1;
        const retryAt = held ? held.retry_at : now + (quota ? probeDelay : retryDelay(failures));
        yield* sql`INSERT INTO failed_turn
        (session_id, fingerprint, failures, quota, failed_at, retry_at, review)
        VALUES (${sessionID}, ${fingerprint}, ${failures}, ${Number(quota)}, ${prior?.failed_at ?? now}, ${retryAt}, ${Number(outgoing.length > 0)})
        ON CONFLICT(session_id) DO UPDATE SET fingerprint = excluded.fingerprint,
        failures = excluded.failures, quota = excluded.quota, retry_at = excluded.retry_at,
        review = excluded.review`;
        if (outgoing.length) {
          if (!prior?.review)
            yield* alerts.raise(
              turnAlert(sessionID),
              "Failed turn needs manual review after an outgoing attempt in this Conversation",
            );
          return;
        }
        if (failures === 3)
          yield* alerts.raise(turnAlert(sessionID), "A Conversation's turn keeps failing");
        if (quota && !held) {
          yield* sql`UPDATE failed_turn SET quota = 1, retry_at = ${retryAt} WHERE review = 0`;
          yield* alerts.clear(provider);
          yield* alerts.raise(cap, "OpenCode Go cap reached");
        }
      });

    const reconcile = (conversation: Conversation, now: number) =>
      Effect.gen(function* () {
        const sessionID = conversation.sessionID;
        const id = Session.ID.make(sessionID);
        const session = yield* host.sessions.get(id).pipe(
          Effect.map(Option.some),
          Effect.catchTag("Session.NotFoundError", () => Effect.succeed(Option.none())),
        );
        if (Option.isNone(session)) {
          yield* sql`UPDATE conversation SET rebuilding = 1 WHERE id = ${conversation.id}`;
          yield* forget(sessionID);
          return [];
        }
        const inbox = yield* host.sessions.inbox(id);
        const [assistant] = yield* host.sessions.messages({
          sessionID: id,
          type: "assistant",
          limit: 1,
        });
        const [prior] =
          yield* sql<Failure>`SELECT * FROM failed_turn WHERE session_id = ${sessionID}`;
        const failed =
          session.value.outcome === "failed" ||
          inbox.length > 0 ||
          (assistant?.type === "assistant" && Boolean(assistant.error));
        // time.idle identifies a completed execution, unlike inbox promotion or
        // a partially written assistant. Those change while a retry is running.
        const fingerprint = JSON.stringify([
          session.value.time.idle && DateTime.toEpochMillis(session.value.time.idle),
        ]);
        if (!failed)
          return prior && prior.fingerprint !== fingerprint ? yield* succeeded(prior) : [];
        yield* record(conversation, fingerprint, assistant, prior, now);
        return [];
      });

    const dispatch = (row: Failure, now: number) =>
      directory.admit(
        row.session_id,
        Effect.gen(function* () {
          const retryAt = now + (row.quota ? probeDelay : retryDelay(row.failures));
          const claimed =
            yield* sql`UPDATE failed_turn SET retry_at = ${retryAt}, last_retry_at = ${now}
          WHERE session_id = ${row.session_id}
          AND fingerprint = ${row.fingerprint} AND retry_at <= ${now} AND review = 0 RETURNING session_id`;
          if (!claimed.length) return;
          if (row.quota)
            yield* sql`UPDATE failed_turn SET retry_at = ${retryAt} WHERE quota = 1 AND review = 0`;
          yield* host
            .retry(Session.ID.make(row.session_id))
            .pipe(Effect.catchCause(Effect.logWarning));
        }),
      );

    const inspect = (sessionIDs?: readonly string[]) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const orphaned = yield* sql<{
          sessionID: string;
        }>`SELECT f.session_id AS sessionID FROM failed_turn f
          WHERE NOT EXISTS (SELECT 1 FROM conversation c JOIN user u ON u.id = c.user_id
            WHERE c.session_id = f.session_id AND c.ended_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM blocked WHERE handle = u.handle)) LIMIT 20`;
        for (const row of orphaned) yield* forget(row.sessionID);
        const batch = yield* recoveryBatch(sessionIDs).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
        for (const conversation of batch.selected) {
          let released: string[] = [];
          yield* directory.admit(
            conversation.sessionID,
            reconcile(conversation, now).pipe(
              Effect.tap((ids) =>
                Effect.sync(() => {
                  released = ids;
                }),
              ),
            ),
          );
          for (const sessionID of released) yield* resume(host, directory, sessionID);
          if (!batch.priority.has(conversation.sessionID))
            yield* sql`INSERT INTO recovery_scan (id, conversation_id) VALUES (1, ${conversation.id})
            ON CONFLICT(id) DO UPDATE SET conversation_id = excluded.conversation_id`;
        }
        const [status] = yield* sql<{ alerted: number; failing: number; quota: number }>`SELECT
          EXISTS(SELECT 1 FROM failed_turn WHERE review = 0 AND quota = 0 AND provider_alerted = 1) AS alerted,
          EXISTS(SELECT 1 FROM failed_turn WHERE review = 0 AND quota = 0 AND failed_at <= ${now - 600_000}) AS failing,
          EXISTS(SELECT 1 FROM failed_turn WHERE review = 0 AND quota = 1) AS quota`;
        if (!status!.alerted && status!.failing) {
          yield* alerts.raise(provider, "Provider failing for 10 minutes");
          yield* sql`UPDATE failed_turn SET provider_alerted = 1 WHERE quota = 0 AND review = 0`;
        }
        const selected =
          yield* sql<Failure>`SELECT * FROM failed_turn WHERE review = 0 AND retry_at <= ${now}
          ORDER BY retry_at, last_retry_at, failed_at, session_id LIMIT ${status!.quota ? 1 : 20}`;
        for (const row of selected) yield* dispatch(row, now);
      });
    const tick = inspect();
    if (eager) yield* tick;
    return {
      tick: lock.withPermit(tick),
      check: (ids: readonly string[]) => lock.withPermit(inspect(ids)),
      forget,
    };
  });
