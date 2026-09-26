import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { conversations } from "../conversations/conversations.ts";

interface PendingRemoval {
  readonly sessionID: string;
}

/** A removal is durable even if OpenCode is unavailable after our transaction commits. */
export const makeOperator = (
  directory: Pick<Effect.Success<typeof conversations>, "block">,
  removeSession: (sessionID: string) => Effect.Effect<void, Error>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      block: directory.block,
      remove: (handle: string) =>
        Effect.gen(function* () {
          // The first phase is atomic: no live User can rebuild a session awaiting removal.
          const pending = yield* Effect.gen(function* () {
            yield* sql`INSERT OR IGNORE INTO removal (handle, session_id)
              SELECT user.handle, conversation.session_id FROM user
              JOIN conversation ON conversation.user_id = user.id WHERE user.handle = ${handle}`;
            yield* sql`DELETE FROM intake_seen WHERE session_id IN
              (SELECT session_id FROM removal WHERE handle = ${handle})`;
            yield* sql`DELETE FROM send WHERE handle = ${handle}`;
            yield* sql`DELETE FROM blocked WHERE handle = ${handle}`;
            yield* sql`DELETE FROM user WHERE handle = ${handle}`;
            return (yield* sql<PendingRemoval>`SELECT session_id AS sessionID FROM removal WHERE handle = ${handle}`)[0];
          }).pipe(sql.withTransaction);
          if (!pending) return "not_found" as const;
          yield* removeSession(pending.sessionID);
          yield* sql`DELETE FROM removal WHERE handle = ${handle}`;
          yield* sql`VACUUM`;
          return "removed" as const;
        }),
    };
  });
