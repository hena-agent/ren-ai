import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Called before deleting the User, while durable removal rows still identify every session. */
export const eraseIntake = (handle: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sessions = sql`SELECT session_id FROM removal WHERE handle = ${handle}
    UNION SELECT session_id FROM retained_session WHERE handle = ${handle}`;
    yield* sql`DELETE FROM intake_pending WHERE handle = ${handle}`;
    for (const table of [
      "intake_seen",
      "intake_edit",
      "context_seen",
      "reply_arrival",
      "failed_turn",
      "catalog_plan",
    ])
      yield* sql`DELETE FROM ${sql(table)} WHERE session_id IN (${sessions})`;
    yield* sql`DELETE FROM application_work WHERE name IN (SELECT 'turn:' || session_id FROM (${sessions}))`;
    yield* sql`DELETE FROM application_checkpoint WHERE name IN (SELECT 'replay:' || session_id FROM (${sessions}))`;
  });
