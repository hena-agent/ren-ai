import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const assignmentCapacity = 5;

/** Called within the same transaction as admission or reservation. */
export const claimPersona = (personaID: string, handle: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const conflicts =
      yield* sql`SELECT 1 FROM persona_assignment WHERE handle = ${handle} AND persona_id != ${personaID}
      UNION SELECT 1 FROM persona_exclusion WHERE handle = ${handle} AND persona_id = ${personaID}
      UNION SELECT 1 WHERE (SELECT COUNT(*) FROM persona_assignment
        WHERE persona_id = ${personaID} AND handle != ${handle}) >= ${assignmentCapacity}`;
    if (conflicts.length) return false;
    yield* sql`INSERT OR IGNORE INTO persona_assignment (persona_id, handle) VALUES (${personaID}, ${handle})`;
    return true;
  });
