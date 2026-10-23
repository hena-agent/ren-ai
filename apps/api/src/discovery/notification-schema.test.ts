import { Effect } from "effect";
import { expect, test } from "vitest";
import { withContactDatabase, contactFixture } from "./contact.test-helper.ts";
import { notificationSchema, notificationSubmissionsSchema } from "./notifications.ts";

test("the submission ledger preserves deployed outcomes and indexes bounded queue/latest queries", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* contactFixture;
      const id = yield* f.register("+821012345678");
      yield* f.sql`DROP TABLE discovery_notification`;
      yield* f.sql`DROP TABLE notification_attempt`;
      yield* notificationSchema;
      yield* f.sql`INSERT INTO discovery_notification VALUES (${id}, 123, 'uncertain', 'original-guid')`;
      yield* f.sql`INSERT INTO notification_attempt VALUES (123)`;
      yield* notificationSubmissionsSchema.pipe(f.sql.withTransaction);
      expect(
        yield* f.sql`SELECT registration_id, created_at, locale, kind, state, guid FROM discovery_notification`,
      ).toEqual([
        {
          registration_id: id,
          created_at: 123,
          locale: "ko",
          kind: "waiting",
          state: "uncertain",
          guid: "original-guid",
        },
      ]);
      expect(yield* f.sql`SELECT * FROM notification_attempt`).toEqual([{ at: 123 }]);
      for (const [query, index] of [
        [
          "SELECT id FROM discovery_notification WHERE state = 'queued' ORDER BY created_at, id LIMIT 5",
          "notification_queue",
        ],
        [
          "SELECT state FROM discovery_notification WHERE registration_id = ? ORDER BY id DESC LIMIT 1",
          "notification_registration",
        ],
      ] as const) {
        const plan = yield* f.sql.unsafe<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${query}`,
          query.includes("?") ? [id] : [],
        );
        expect(plan.some((row) => row.detail.includes(index))).toBe(true);
        expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false);
      }
      yield* f.sql`DELETE FROM discovery_registration`;
      expect(yield* f.sql`SELECT id FROM discovery_notification`).toEqual([]);
    }),
  ));
