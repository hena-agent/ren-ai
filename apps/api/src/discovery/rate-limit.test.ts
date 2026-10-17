import { Effect } from "effect";
import { expect, test } from "vitest";
import { submissionLimit } from "./rate-limit.ts";
import { migrate } from "../database.ts";
import { runMessagingTest } from "../../test/messaging.test-helper.ts";
import { SqlClient } from "effect/unstable/sql";

test("rejected retries do not extend the window and actor replacement retains admission history", () =>
  runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const limit = yield* submissionLimit;
      for (let i = 0; i < 5; i++) expect(yield* limit("visitor", 0)).toBe(false);
      const replacement = yield* submissionLimit;
      expect(yield* replacement("visitor", 3_599_999)).toBe(true);
      expect(yield* replacement("visitor", 3_600_000)).toBe(false);
      expect(yield* replacement(undefined, 3_600_001)).toBe(false);
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
      expect(yield* limit("new-visitor", 1)).toBe(true);
      expect(yield* limit("new-visitor", 3_600_000)).toBe(false);
    }),
  ));
