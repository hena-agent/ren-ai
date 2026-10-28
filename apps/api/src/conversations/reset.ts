import { Clock, Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { conversations } from "./conversations.ts";
import type { IncomingMessage, Messages } from "@ren-ai/imsg";
import { resetBoundary } from "./reset-boundary.ts";
import { withLifecycle } from "./lifecycle.ts";
import { recordEnding } from "./ending-record.ts";
import { scheduleWork } from "../scheduling.ts";

export const resets = (
  directory: Effect.Success<typeof conversations>,
  forget: (sessionID: string) => Effect.Effect<void>,
  messages: Messages,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const beforeReset = yield* resetBoundary(messages);
    const receive = (row: IncomingMessage) =>
      Effect.gen(function* () {
        if (row.fromMe || row.tapback || row.text.trim().toLowerCase() !== "/reset") return;
        yield* directory.withHandle(row.handle)(
          Effect.gen(function* () {
            if ((yield* sql`SELECT 1 FROM intake_seen WHERE guid = ${row.guid}`).length) return;
            if (yield* beforeReset(row)) return;
            if (!(yield* sql`SELECT 1 FROM test_handle WHERE handle = ${row.handle}`).length)
              return;
            const oldID = yield* withLifecycle(
              Effect.gen(function* () {
                const conversation = yield* directory.byHandle(row.handle);
                if (!conversation) return undefined;
                if (
                  (yield* sql`SELECT 1 FROM conversation WHERE id = ${conversation.id} AND started_at > ${row.createdAt}`)
                    .length
                )
                  return undefined;
                yield* sql.withTransaction(
                  Effect.gen(function* () {
                    // Keep the command cutoff and ending atomic: replay cannot end the next relationship.
                    yield* recordEnding(conversation, "", `reset_${row.guid}`, "user");
                    yield* sql`INSERT INTO reset (guid, handle, row_id, date, session_id, complete)
                      VALUES (${row.guid}, ${row.handle}, ${row.id}, ${row.createdAt}, ${conversation.sessionID}, 1)`;
                    yield* scheduleWork("endings", yield* Clock.currentTimeMillis);
                  }),
                );
                return conversation.sessionID;
              }),
            );
            if (!oldID) return;
            yield* forget(oldID);
          }),
        );
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    return { receive };
  });
