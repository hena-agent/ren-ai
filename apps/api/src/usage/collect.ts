import type { MessageListInput, MessageListOutput } from "@opencode/client/effect/api";
import { Session } from "@opencode/schema/session";
import { Cause, Clock, Effect, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { contactCause, contactLog } from "../discovery/diagnostics.ts";
import { randomUUID } from "node:crypto";
import { saveUsage } from "./save.ts";
import { safetyInterval } from "../scheduling.ts";
import { claimWork, workBatchSize } from "../work-budget.ts";

export const usageCollector = (api: {
  readonly messages: (input: MessageListInput) => Effect.Effect<MessageListOutput, Error>;
  readonly get: (id: Session.ID) => Effect.Effect<Session.Info, Error>;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const lock = yield* Semaphore.make(1);
    const collect = (sessionID: string) =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        const work = Effect.gen(function* () {
          const [bound] = yield* sql`SELECT 1 FROM usage_session WHERE session_id = ${sessionID}`;
          if (!bound) return;
          // Native cursors paginate a snapshot, not a change feed. SQL persists only changed accounting metadata.
          const messages: MessageListOutput["data"][number][] = [];
          let cursor: string | undefined;
          const visited = new Set<string>();
          do {
            const page = yield* api.messages({
              sessionID: Session.ID.make(sessionID),
              ...(cursor ? { cursor } : { order: "asc", limit: 100 }),
            });
            messages.push(...page.data);
            cursor = page.cursor.next;
            if (cursor && visited.has(cursor))
              yield* Effect.fail(new Error("Repeated usage message cursor"));
            if (cursor) visited.add(cursor);
          } while (cursor);
          const session = yield* api.get(Session.ID.make(sessionID));
          const now = yield* Clock.currentTimeMillis;
          yield* Effect.gen(function* () {
            const live = yield* sql`SELECT 1 FROM usage_session WHERE session_id = ${sessionID}`;
            if (live.length) yield* saveUsage(sql, session, messages, now);
          }).pipe(sql.withTransaction);
        });
        yield* work.pipe(
          Effect.timeout("30 seconds"),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              contactLog({
                requestId: randomUUID(),
                operation: "conversation.usage",
                stage: "session.messages",
                outcome: "failed",
                level: "error",
                durationMs: (yield* Clock.currentTimeMillis) - started,
                ...contactCause(Cause.squash(cause)),
              });
              yield* sql`UPDATE usage_session SET unavailable = 1 WHERE session_id = ${sessionID} AND unavailable = 0`;
              return yield* Effect.fail(
                new Error("Conversation usage snapshot unavailable", {
                  cause: Cause.squash(cause),
                }),
              );
            }),
          ),
        );
      });
    return {
      session: (id: string) => lock.withPermit(collect(id)),
      tick: lock.withPermit(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const limit = Math.min(20, yield* workBatchSize);
          const rows = yield* sql<{
            sessionID: string;
            current: number | null;
            stoppedAt: number | null;
            syncedAt: number | null;
          }>`SELECT s.session_id AS sessionID, c.id AS current, e.stopped_at AS stoppedAt, s.synced_at AS syncedAt FROM usage_session s
            LEFT JOIN conversation c ON c.session_id = s.session_id AND c.usage_key = s.conversation_key
            LEFT JOIN conversation_end e ON e.conversation_id = c.id
            WHERE s.next_check_at <= ${now}
             ORDER BY s.next_check_at, s.session_id LIMIT ${limit}`;
          yield* Effect.forEach(
            rows,
            (row) =>
              Effect.gen(function* () {
                if (!(yield* claimWork)) return;
                if (
                  row.current === null ||
                  (row.stoppedAt !== null && row.syncedAt !== null && row.syncedAt >= row.stoppedAt)
                ) {
                  yield* sql`UPDATE usage_session SET next_check_at = NULL WHERE session_id = ${row.sessionID}`;
                  return;
                }
                const checked = yield* collect(row.sessionID).pipe(
                  Effect.as(true),
                  Effect.catch(() => Effect.succeed(false)),
                );
                yield* sql`UPDATE usage_session SET next_check_at = ${checked && row.stoppedAt !== null ? null : now + safetyInterval},
                  synced_at = CASE WHEN ${Number(checked)} THEN ${now} ELSE synced_at END WHERE session_id = ${row.sessionID}`;
              }),
            { discard: true },
          );
        }),
      ),
    };
  });
