import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { randomUUID } from "node:crypto";
import { contactCause, contactLog } from "./diagnostics.ts";

/** Called within the same transaction as admission or reservation. */
export const claimPersona = (personaID: string, handle: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const conflicts =
      yield* sql`SELECT 1 FROM user LEFT JOIN conversation ON conversation.user_id = user.id
      WHERE COALESCE(conversation.persona_id, user.persona_id) = ${personaID} AND user.handle != ${handle}
      UNION SELECT 1 FROM persona_assignment
      WHERE (persona_id = ${personaID} AND handle != ${handle}) OR (handle = ${handle} AND persona_id != ${personaID})`;
    if (conflicts.length) return false;
    yield* sql`INSERT OR IGNORE INTO persona_assignment (persona_id, handle) VALUES (${personaID}, ${handle})`;
    return true;
  });

/** Validate existing live assignments before exposing admission routes. */
export const checkAssignments = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const duplicates = yield* sql`SELECT COALESCE(conversation.persona_id, user.persona_id) AS persona
    FROM user LEFT JOIN conversation ON conversation.user_id = user.id
    WHERE COALESCE(conversation.persona_id, user.persona_id) IS NOT NULL
    GROUP BY persona HAVING COUNT(*) > 1`;
  if (duplicates.length) {
    const error = new Error(
      "Existing personas have multiple users; resolve assignments before deployment",
    );
    contactLog({
      requestId: randomUUID(),
      operation: "discovery.startup",
      stage: "assignment.preflight",
      outcome: "failed",
      level: "error",
      durationMs: 0,
      code: "assignment_conflict",
      ...contactCause(error),
    });
    yield* Effect.fail(error);
  }
});
