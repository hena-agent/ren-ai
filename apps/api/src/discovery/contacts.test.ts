import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { contacts } from "./contacts.ts";
import { checkAssignments, claimPersona } from "./assignment.ts";
import { contactFixture, withContactDatabase } from "./contact.test-helper.ts";

test("selection reserves exclusive personas, bounded times and durable deduplication", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const { store, register, sql } = yield* contactFixture;
      yield* register("first@example.net", ["luna", "harin"]);
      yield* register("second@example.net", ["luna", "harin"]);
      yield* register("third@example.net", ["luna", "harin"]);
      expect((yield* store.list).eligibleCount).toBe(3);
      const input = { requestId: randomUUID(), count: 10 };
      const started = Date.now();
      const selected = yield* store.select(input, "server-request");
      expect(selected.entries).toHaveLength(2);
      expect(new Set(selected.entries.map((row) => row.persona!.id)).size).toBe(2);
      for (const row of selected.entries) {
        expect(row.state).toBe("scheduled");
        expect(row.scheduledAt).toBeGreaterThanOrEqual(started + 300_000);
        expect(row.scheduledAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
        expect(row.requestId).toBe("server-request");
      }
      expect(yield* store.select(input, "retry")).toEqual(selected);
      expect(yield* sql`SELECT * FROM discovery_contact`).toHaveLength(2);
      expect((yield* store.list).eligibleCount).toBe(0);
      yield* Effect.promise(async () =>
        expect(
          await Effect.runPromise(
            store.select({ ...input, count: 1 }, "conflict").pipe(Effect.result),
          ),
        ).toHaveProperty("_tag", "Failure"),
      );
    }),
  );
});

test("concurrent selections cannot allocate a persona or handle twice", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const { store, register, sql } = yield* contactFixture;
      yield* register("one@example.net");
      yield* register("two@example.net");
      const results = yield* Effect.all(
        [
          store.select({ requestId: randomUUID(), count: 1 }, "a"),
          store.select({ requestId: randomUUID(), count: 1 }, "b"),
        ],
        { concurrency: "unbounded" },
      );
      expect(results.flatMap((result) => result.entries)).toHaveLength(1);
      expect(yield* sql`SELECT * FROM persona_assignment`).toHaveLength(1);
    }),
  );
});

test("eligibility excludes blocked, removed, resetting, admitted, pending and unavailable Likes", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const { store, register, sql, profiles } = yield* contactFixture;
      for (const handle of ["blocked", "removed", "reset", "active", "pending", "gone", "ready"])
        yield* register(`${handle}@example.net`, [handle === "gone" ? "missing" : "jiwoo"]);
      yield* sql`INSERT INTO blocked VALUES ('blocked@example.net', 1)`;
      yield* sql`INSERT INTO removal VALUES ('removed@example.net', 'old-session')`;
      yield* sql`INSERT INTO reset (guid, handle, row_id, date, session_id) VALUES ('reset', 'reset@example.net', 1, 1, 'reset-session')`;
      yield* sql`INSERT INTO user (handle, locale, consent_version, consent_language, consent_at, joined_at, persona_id) VALUES ('active@example.net', 'ko', 'v', 'ko', 1, 2, 'other')`;
      yield* sql`INSERT INTO user (handle, locale, consent_version, consent_language, consent_at) VALUES ('pending@example.net', 'ko', 'v', 'ko', 1)`;
      const rows = yield* store.list;
      expect(rows.entries.filter((row) => row.eligible).map((row) => row.handle)).toEqual([
        "ready@example.net",
      ]);
      expect(rows.entries.find((row) => row.handle.startsWith("active"))?.state).toBe("active");
      profiles.splice(0);
      expect((yield* store.list).eligibleCount).toBe(0);
      expect((yield* store.select({ requestId: randomUUID(), count: 3 }, "none")).entries).toEqual(
        [],
      );
    }),
  );
});

test("claiming includes legacy conversations and assignments and detects conflicting live data", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const { sql } = yield* contactFixture;
      expect(yield* claimPersona("luna", "one@example.net")).toBe(true);
      expect(yield* claimPersona("luna", "one@example.net")).toBe(true);
      expect(yield* claimPersona("luna", "two@example.net")).toBe(false);
      expect(yield* claimPersona("harin", "one@example.net")).toBe(false);
      yield* sql`INSERT INTO user (handle, locale, consent_version, consent_language, consent_at, persona_id) VALUES ('legacy', 'ko', 'v', 'ko', 1, 'harin')`;
      expect(yield* claimPersona("harin", "third@example.net")).toBe(false);
      yield* checkAssignments;
      yield* sql`INSERT INTO user (handle, locale, consent_version, consent_language, consent_at, persona_id) VALUES ('duplicate', 'ko', 'v', 'ko', 1, 'harin')`;
      expect(yield* checkAssignments.pipe(Effect.flip)).toEqual(
        new Error("Existing personas have multiple users; resolve assignments before deployment"),
      );
    }),
  );
});

test("Catalog outages and failed reservations do not produce partial assignments", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const { register, sql, store } = yield* contactFixture;
      const offline = yield* contacts(async () => {
        throw new Error("private provider error");
      });
      expect(yield* offline.list.pipe(Effect.flip)).toEqual(
        new Error("Public Catalog unavailable"),
      );
      yield* register("one@example.net");
      yield* sql`CREATE TRIGGER fail_contact BEFORE INSERT ON discovery_contact BEGIN SELECT RAISE(ABORT, 'fail'); END`;
      yield* store.select({ requestId: randomUUID(), count: 1 }, "failed").pipe(Effect.flip);
      expect(yield* sql`SELECT * FROM persona_assignment`).toEqual([]);
      expect(yield* sql`SELECT * FROM discovery_selection`).toEqual([]);
    }),
  );
});

test("stale Catalog labels preserve booked IDs and a concurrent claimant wins safely", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const { register, sql, store, profiles } = yield* contactFixture;
      yield* register("one@example.net");
      yield* store.select({ requestId: randomUUID(), count: 1 }, "booked");
      profiles.splice(0);
      expect((yield* store.list).entries[0]?.persona).toEqual({ id: "luna", name: "luna" });
      yield* sql`DELETE FROM discovery_contact`;
      yield* sql`DELETE FROM persona_assignment`;
      profiles.push({
        id: "luna",
        name: "luna",
        bio: "public",
        imageUrl: "https://images.test/photo.jpg",
      });
      yield* sql`CREATE TRIGGER concurrent_claim AFTER INSERT ON discovery_selection
      BEGIN INSERT INTO persona_assignment VALUES ('luna', 'winner@example.net'); END`;
      expect(
        (yield* store.select({ requestId: randomUUID(), count: 1 }, "racing")).entries,
      ).toEqual([]);
    }),
  );
});
