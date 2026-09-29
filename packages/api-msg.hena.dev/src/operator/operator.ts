import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { conversations } from "../conversations/conversations.ts";

interface PendingRemoval {
  readonly sessionID: string;
}

/** A removal is durable even if OpenCode is unavailable after our transaction commits. */
export const makeOperator = (
  directory: Pick<Effect.Success<typeof conversations>, "block" | "withHandle">,
  removeSession: (sessionID: string) => Effect.Effect<void, Error>,
  rebuildSession: (
    handle: string,
  ) => Effect.Effect<"rebuilt" | "not_found" | "present", Error> = () =>
    Effect.succeed("not_found"),
  retainSession: (sessionID: string, handle: string) => Effect.Effect<void, Error> = () =>
    Effect.fail(new Error("Session retention unavailable")),
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      block: directory.block,
      testHandle: (handle: string, enabled: boolean) =>
        (enabled
          ? sql`INSERT OR IGNORE INTO test_handle (handle) VALUES (${handle})`
          : sql`DELETE FROM test_handle WHERE handle = ${handle}`
        ).pipe(Effect.asVoid),
      rebuild: rebuildSession,
      remove: (handle: string) =>
        directory.withHandle(handle)(
          Effect.gen(function* () {
            // The first phase is atomic: no live User can rebuild a session awaiting removal.
            const state = yield* Effect.gen(function* () {
              const existed = (yield* sql`SELECT 1 FROM user WHERE handle = ${handle}`).length > 0;
              const keep =
                (yield* sql`SELECT 1 FROM test_handle WHERE handle = ${handle}`).length > 0;
              yield* sql`INSERT OR IGNORE INTO removal (handle, session_id)
              SELECT user.handle, conversation.session_id FROM user
              JOIN conversation ON conversation.user_id = user.id WHERE user.handle = ${handle}`;
              if (!keep)
                yield* sql`INSERT OR IGNORE INTO removal SELECT handle, session_id
              FROM retained_session WHERE handle = ${handle}`;
              yield* sql`DELETE FROM intake_seen WHERE session_id IN
              (SELECT session_id FROM removal WHERE handle = ${handle})`;
              yield* sql`DELETE FROM send WHERE handle = ${handle}`;
              yield* sql`DELETE FROM blocked WHERE handle = ${handle}`;
              yield* sql`DELETE FROM waitlist WHERE email = ${handle}`;
              yield* sql`DELETE FROM user WHERE handle = ${handle}`;
              yield* sql`DELETE FROM reset WHERE handle = ${handle}`;
              const pending =
                yield* sql<PendingRemoval>`SELECT session_id AS sessionID FROM removal WHERE handle = ${handle}`;
              return { pending, existed, keep };
            }).pipe(sql.withTransaction);
            if (!state.pending.length && !state.existed) return "not_found" as const;
            for (const pending of state.pending) {
              if (state.keep) yield* retainSession(pending.sessionID, handle);
              else yield* removeSession(pending.sessionID);
            }
            if (!state.keep) yield* sql`DELETE FROM retained_session WHERE handle = ${handle}`;
            yield* sql`DELETE FROM removal WHERE handle = ${handle}`;
            yield* sql`VACUUM`;
            return "removed" as const;
          }),
        ),
      removeWaitlist: (email: string) =>
        Effect.gen(function* () {
          const rows = yield* sql`DELETE FROM waitlist WHERE email = ${email} RETURNING id`;
          if (!rows.length) return "not_found" as const;
          yield* sql`VACUUM`;
          return "removed" as const;
        }),
    };
  });
