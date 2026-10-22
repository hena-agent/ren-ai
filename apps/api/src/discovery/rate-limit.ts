import { createHash } from "node:crypto";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

const keyFor = (ip: string | undefined) =>
  createHash("sha256")
    .update(ip ?? "missing")
    .digest("hex");

/** Bound each maintenance transaction; persisted indexed deadlines also run without visitors. */
export const expireSubmissionLimits = (now: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM discovery_attempt WHERE rowid IN (SELECT rowid FROM discovery_attempt WHERE at <= ${now - 3_600_000} ORDER BY at LIMIT 500)`;
    yield* sql`DELETE FROM discovery_verification WHERE ip IN (SELECT ip FROM discovery_verification WHERE at <= ${now - 60_000} ORDER BY at LIMIT 500)`;
  });

const evictOldest = (
  sql: SqlClient.SqlClient,
  table: "discovery_attempt" | "discovery_verification",
) => sql`DELETE FROM ${sql(table)} WHERE ip = (SELECT ip FROM ${sql(table)} ORDER BY at LIMIT 1)`;

/** A separate 30/minute IP gate bounds verification calls without spending registration credit. */
export const verificationLimit = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (ip: string | undefined, now: number) =>
    Effect.gen(function* () {
      const key = keyFor(ip);
      const [visitor] = yield* sql<{
        at: number;
        attempts: number;
      }>`SELECT at, attempts FROM discovery_verification WHERE ip = ${key}`;
      if (visitor && visitor.at + 60_000 > now && visitor.attempts >= 30) return true;
      if (!visitor) {
        const [total] = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM discovery_verification`;
        if (total!.count >= 10_000) yield* evictOldest(sql, "discovery_verification");
      }
      yield* sql`INSERT INTO discovery_verification(ip, at, attempts) VALUES (${key}, ${now}, 1)
      ON CONFLICT(ip) DO UPDATE SET attempts = CASE WHEN at <= ${now - 60_000} THEN 1 ELSE attempts + 1 END,
        at = CASE WHEN at <= ${now - 60_000} THEN excluded.at ELSE at END`;
      return false;
    }).pipe(sql.withTransaction);
});

export const submissionLimit = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (ip: string | undefined, now: number) =>
    Effect.gen(function* () {
      const key = keyFor(ip);
      yield* expireSubmissionLimits(now).pipe(Effect.provideService(SqlClient.SqlClient, sql));
      const [visitor] = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM discovery_attempt WHERE ip = ${key} AND at > ${now - 3_600_000}`;
      if (visitor!.count >= 5) return true;
      if (visitor!.count === 0) {
        const [total] = yield* sql<{
          count: number;
        }>`SELECT COUNT(DISTINCT ip) AS count FROM discovery_attempt`;
        if (total!.count >= 10_000) yield* evictOldest(sql, "discovery_attempt");
      }
      yield* sql`INSERT INTO discovery_attempt (ip, at) VALUES (${key}, ${now})`;
      return false;
    }).pipe(sql.withTransaction);
});
