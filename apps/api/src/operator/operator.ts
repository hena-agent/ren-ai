import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { conversations } from "../conversations/conversations.ts";
import { withLifecycle } from "../conversations/lifecycle.ts";
import { eraseIntake } from "./erase.ts";

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
              const existed =
                (yield* sql`SELECT 1 FROM user WHERE handle = ${handle}
                UNION SELECT 1 FROM discovery_registration WHERE handle = ${handle}`).length > 0;
              const keep =
                (yield* sql`SELECT 1 FROM test_handle WHERE handle = ${handle}`).length > 0;
              // Keep scope identity in the retry marker before erasing accounting and live rows.
              yield* sql`INSERT OR IGNORE INTO removal (handle, session_id, persona_id, conversation_key)
              SELECT user.handle, conversation.session_id, conversation.persona_id, conversation.usage_key FROM user
              JOIN conversation ON conversation.user_id = user.id WHERE user.handle = ${handle}`;
              yield* sql`INSERT OR IGNORE INTO removal (handle, session_id, persona_id, conversation_key)
                SELECT u.handle, s.session_id, s.persona_id, s.conversation_key FROM usage_session s JOIN conversation c ON c.usage_key = s.conversation_key
                JOIN user u ON u.id = c.user_id WHERE u.handle = ${handle}`;
              yield* sql`INSERT OR IGNORE INTO removal (handle, session_id, persona_id, conversation_key)
                SELECT r.handle, c.session_id, c.persona_id, c.session_id FROM discovery_contact c JOIN discovery_registration r ON r.id = c.registration_id
                WHERE r.handle = ${handle} AND c.session_id IS NOT NULL`;
              if (!keep)
                yield* sql`INSERT OR IGNORE INTO removal (handle, session_id, persona_id, conversation_key)
                  SELECT r.handle, r.session_id, COALESCE(r.persona_id, s.persona_id), COALESCE(r.conversation_key, s.conversation_key)
                  FROM retained_session r LEFT JOIN usage_session s ON s.session_id = r.session_id WHERE r.handle = ${handle}`;
              yield* eraseIntake(handle, keep).pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
              );
              yield* sql`DELETE FROM send WHERE handle = ${handle}`;
              yield* sql`DELETE FROM blocked WHERE handle = ${handle}`;
              yield* sql`DELETE FROM discovery_registration WHERE handle = ${handle}`;
              yield* sql`DELETE FROM persona_assignment WHERE handle = ${handle}`;
              yield* sql`DELETE FROM user WHERE handle = ${handle}`;
              yield* sql`DELETE FROM reset WHERE handle = ${handle}`;
              const pending =
                yield* sql<PendingRemoval>`SELECT session_id AS sessionID FROM removal WHERE handle = ${handle}`;
              return { pending, existed, keep };
            }).pipe(sql.withTransaction, withLifecycle);
            if (!state.pending.length && !state.existed) return "not_found" as const;
            for (const pending of state.pending) {
              if (state.keep) {
                yield* retainSession(pending.sessionID, handle);
                yield* sql`UPDATE retained_session SET (persona_id, conversation_key) =
                  (SELECT persona_id, conversation_key FROM removal WHERE session_id = ${pending.sessionID})
                  WHERE session_id = ${pending.sessionID}`;
              } else yield* removeSession(pending.sessionID);
            }
            if (!state.keep) yield* sql`DELETE FROM retained_session WHERE handle = ${handle}`;
            yield* sql`DELETE FROM removal WHERE handle = ${handle}`;
            yield* sql`VACUUM`;
            return "removed" as const;
          }),
        ),
    };
  });
