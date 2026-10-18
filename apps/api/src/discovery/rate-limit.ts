import { createHash } from "node:crypto";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const submissionLimit = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (ip: string | undefined, now: number) =>
    Effect.gen(function* () {
      const key = createHash("sha256")
        .update(ip ?? "missing")
        .digest("hex");
      yield* sql`DELETE FROM discovery_attempt WHERE at <= ${now - 3_600_000}`;
      const [visitor] = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM discovery_attempt WHERE ip = ${key}`;
      if (visitor!.count >= 5) return true;
      if (visitor!.count === 0) {
        const [total] = yield* sql<{
          count: number;
        }>`SELECT COUNT(DISTINCT ip) AS count FROM discovery_attempt`;
        if (total!.count >= 10_000) return true;
      }
      yield* sql`INSERT INTO discovery_attempt (ip, at) VALUES (${key}, ${now})`;
      return false;
    }).pipe(sql.withTransaction);
});
