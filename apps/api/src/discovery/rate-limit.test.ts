import { Effect } from "effect";
import { expect, test } from "vitest";
import { expireSubmissionLimits, submissionLimit, verificationLimit } from "./rate-limit.ts";
import { nextApplicationWake } from "../scheduling.ts";
import { migrate } from "../database.ts";
import { runMessagingTest } from "../../test/messaging.test-helper.ts";
import { SqlClient } from "effect/unstable/sql";

test("rejected retries do not extend the window and actor replacement retains admission history", () =>
  runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const limit = yield* submissionLimit;
      for (let i = 0; i < 30; i++) expect(yield* limit("visitor", 0)).toBe(0);
      const replacement = yield* submissionLimit;
      expect(yield* replacement("visitor", 3_599_999)).toBe(1);
      expect(yield* replacement("visitor", 3_600_000)).toBe(0);
      expect(yield* replacement(undefined, 3_600_001)).toBe(0);
    }),
  ));

test("the durable visitor budget bounds storage and opens again after the window expires", () =>
  runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`WITH RECURSIVE visitors(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM visitors WHERE id < 10000)
    INSERT INTO discovery_attempt (ip, at) SELECT CAST(id AS TEXT), 0 FROM visitors`;
      const limit = yield* submissionLimit;
      expect(yield* limit("new-visitor", 1)).toBe(0);
      expect(yield* limit("new-visitor", 3_600_000)).toBe(0);
    }),
  ));

test("verification has its own durable minute budget and never consumes verified registration credit", () =>
  runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const sql = yield* SqlClient.SqlClient;
      const limit = yield* verificationLimit;
      for (let i = 0; i < 30; i++) expect(yield* limit("raw-private-ip", 0)).toBe(0);
      expect(yield* (yield* verificationLimit)("raw-private-ip", 59_999)).toBe(1);
      expect(yield* sql`SELECT 1 FROM discovery_attempt`).toEqual([]);
      expect(JSON.stringify(yield* sql`SELECT * FROM discovery_verification`)).not.toContain(
        "raw-private-ip",
      );
      expect(yield* limit("raw-private-ip", 60_000)).toBe(0);
      const admitted = yield* submissionLimit;
      expect(yield* admitted("raw-private-ip", 60_000)).toBe(0);
      expect(yield* sql`SELECT attempts FROM discovery_verification`).toEqual([{ attempts: 1 }]);
    }),
  ));

test("capacity evicts old fingerprints rather than closing admission for new visitors, and expiry reads are indexed and bounded", () =>
  runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i < 10000)
    INSERT INTO discovery_verification SELECT 'old-' || i, 0, 1 FROM n`;
      const verification = yield* verificationLimit;
      expect(yield* verification("new", 1)).toBe(0);
      expect(yield* sql`SELECT COUNT(*) AS n FROM discovery_verification`).toEqual([{ n: 10000 }]);
      const [before] = yield* sql<{ n: number }>`SELECT total_changes() AS n`;
      yield* expireSubmissionLimits(60_001);
      const [after] = yield* sql<{ n: number }>`SELECT total_changes() AS n`;
      expect(after!.n - before!.n).toBe(500);
      const plan =
        yield* sql`EXPLAIN QUERY PLAN SELECT ip FROM discovery_verification WHERE at <= 0 ORDER BY at LIMIT 500`;
      expect(JSON.stringify(plan)).toContain("verification_expiry");
      expect(yield* nextApplicationWake).toBeLessThanOrEqual(Date.now() + 1100);
    }),
  ));
