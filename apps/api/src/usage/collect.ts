import type { MessageListInput, MessageListOutput } from "@opencode/client/effect/api";
import { Session } from "@opencode/schema/session";
import { Cause, Clock, Effect, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { contactCause, contactLog } from "../discovery/diagnostics.ts";
import { randomUUID } from "node:crypto";
import { bindUsageSessions } from "./schema.ts";
import { saveUsage } from "./save.ts";

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
          // ponytail: replay paginated metadata for correctness; add incremental snapshots if long histories make polling costly.
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
          yield* saveUsage(sql, session, messages, now).pipe(sql.withTransaction);
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
              yield* sql`UPDATE usage_session SET unavailable = 1 WHERE session_id = ${sessionID}`;
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
          yield* bindUsageSessions(sql);
          const rows = yield* sql<{
            sessionID: string;
          }>`SELECT session_id AS sessionID FROM usage_session ORDER BY synced_at, session_id`;
          yield* Effect.forEach(
            rows,
            (row) => collect(row.sessionID).pipe(Effect.catch(() => Effect.void)),
            { discard: true },
          );
        }),
      ),
    };
  });
