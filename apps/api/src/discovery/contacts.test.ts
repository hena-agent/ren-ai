import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { contacts } from "./contacts.ts";
import { claimPersona } from "./assignment.ts";
import { contactFixture, withContactDatabase } from "./contact.test-helper.ts";

test("selection reserves up to five assignments of the same persona, bounded times and durable deduplication", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const { store, register, sql } = yield* contactFixture;
      for (let index = 0; index < 6; index++) yield* register(`user${index}@example.net`);
      expect((yield* store.list).eligibleCount).toBe(6);
      const input = { requestId: randomUUID(), count: 10 };
      const started = Date.now();
      const selected = yield* store.select(input, "server-request");
      expect(selected.entries).toHaveLength(5);
      expect(new Set(selected.entries.map((row) => row.persona!.id))).toEqual(new Set(["luna"]));
      for (const row of selected.entries) {
        expect(row.state).toBe("scheduled");
        expect(row.scheduledAt).toBeGreaterThanOrEqual(started + 300_000);
        expect(row.scheduledAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
        expect(row.requestId).toBe("server-request");
      }
      expect(yield* store.select(input, "retry")).toEqual(selected);
      expect(yield* sql`SELECT * FROM discovery_contact`).toHaveLength(5);
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

test("a waiting test handle starts now with its chosen available Like, once per request", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const { store, register, sql } = yield* contactFixture;
      const tester = yield* register("tester@example.net", ["luna", "harin"]);
      const stranger = yield* register("stranger@example.net", ["jiwoo"]);
      yield* sql`INSERT INTO test_handle VALUES ('tester@example.net')`;
      const marks = (yield* store.list).entries.map((row) => [row.handle, row.testHandle]);
      expect(marks).toContainEqual(["tester@example.net", true]);
      expect(marks).toContainEqual(["stranger@example.net", false]);
      const start = (registrationID: string, personaID: string) =>
        store.start({ requestId: randomUUID(), registrationID, personaID }, "refused");
      expect(yield* start(stranger, "jiwoo")).toBeNull();
      expect(yield* start(tester, "jiwoo")).toBeNull();
      expect(yield* start(randomUUID(), "luna")).toBeNull();
      for (let index = 0; index < 5; index++)
        yield* sql`INSERT INTO persona_assignment VALUES ('harin', ${`other${index}@example.net`})`;
      expect(yield* start(tester, "harin")).toBeNull();
      expect(yield* sql`SELECT * FROM discovery_selection`).toEqual([]);
      const input = { requestId: randomUUID(), registrationID: tester, personaID: "luna" };
      const before = Date.now();
      const started = yield* store.start(input, "server-request");
      expect(started).toMatchObject({
        requestId: input.requestId,
        requested: 1,
        entries: [
          {
            id: tester,
            state: "scheduled",
            persona: { id: "luna", name: "luna" },
            requestId: "server-request",
          },
        ],
      });
      expect(started!.entries[0]!.scheduledAt).toBeGreaterThanOrEqual(before);
      expect(started!.entries[0]!.scheduledAt).toBeLessThanOrEqual(Date.now());
      expect(yield* store.start(input, "retry")).toEqual(started);
      expect(yield* start(tester, "luna")).toBeNull();
      expect(yield* sql`SELECT persona_id FROM persona_assignment ORDER BY persona_id`).toEqual([
        { persona_id: "harin" },
        { persona_id: "harin" },
        { persona_id: "harin" },
        { persona_id: "harin" },
        { persona_id: "harin" },
        { persona_id: "luna" },
      ]);
    }),
  );
});

test("direct selection only reserves checked eligible registrations with the normal random delay", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const { store, register, sql } = yield* contactFixture;
      const checked = yield* register("checked@example.net", ["luna", "harin"]);
      const blocked = yield* register("blocked@example.net", ["jiwoo"]);
      const unchecked = yield* register("unchecked@example.net", ["jiwoo"]);
      yield* sql`INSERT INTO blocked VALUES ('blocked@example.net', 1)`;
      const input = {
        requestId: randomUUID(),
        count: 3,
        registrationIDs: [checked, blocked, randomUUID()],
      };
      const before = Date.now();
      const selected = yield* store.select(input, "direct-request");
      expect(selected.requested).toBe(3);
      expect(selected.entries.map((row) => row.id)).toEqual([checked]);
      expect(["luna", "harin"]).toContain(selected.entries[0]!.persona!.id);
      expect(selected.entries[0]!.state).toBe("scheduled");
      expect(selected.entries[0]!.scheduledAt).toBeGreaterThanOrEqual(before + 300_000);
      expect(selected.entries[0]!.scheduledAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
      expect(yield* store.select(input, "retry")).toEqual(selected);
      expect((yield* store.list).entries.find((row) => row.id === unchecked)?.eligible).toBe(true);
      expect(yield* sql`SELECT * FROM discovery_contact`).toHaveLength(1);
      expect(
        yield* store
          .select({ ...input, requestId: randomUUID(), count: 1 }, "mismatch")
          .pipe(Effect.flip),
      ).toEqual(new Error("Selection count must match selected registrations"));
    }),
  );
});

test("a test start that loses its persona to a concurrent claim leaves no reservation", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const { store, register, sql } = yield* contactFixture;
      const tester = yield* register("tester@example.net");
      yield* sql`INSERT INTO test_handle VALUES ('tester@example.net')`;
      for (let index = 0; index < 4; index++)
        yield* sql`INSERT INTO persona_assignment VALUES ('luna', ${`other${index}`})`;
      yield* sql`CREATE TRIGGER concurrent_claim AFTER INSERT ON discovery_selection
      BEGIN INSERT INTO persona_assignment VALUES ('luna', 'winner@example.net'); END`;
      expect(
        yield* store.start(
          { requestId: randomUUID(), registrationID: tester, personaID: "luna" },
          "racing",
        ),
      ).toBeNull();
      expect(yield* sql`SELECT * FROM discovery_selection`).toEqual([]);
      expect(yield* sql`SELECT * FROM discovery_contact`).toEqual([]);
      yield* sql`DROP TRIGGER concurrent_claim`;
      yield* sql`DELETE FROM persona_assignment`;
      yield* sql`CREATE TRIGGER fail_contact BEFORE INSERT ON discovery_contact BEGIN SELECT RAISE(ABORT, 'fail'); END`;
      yield* store
        .start({ requestId: randomUUID(), registrationID: tester, personaID: "luna" }, "failed")
        .pipe(Effect.flip);
      expect(yield* sql`SELECT * FROM persona_assignment`).toEqual([]);
    }),
  );
});

test("concurrent selections cannot exceed five assignments or allocate a handle twice", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const { store, register, sql } = yield* contactFixture;
      for (let index = 0; index < 8; index++) yield* register(`user${index}@example.net`);
      const results = yield* Effect.all(
        [
          store.select({ requestId: randomUUID(), count: 4 }, "a"),
          store.select({ requestId: randomUUID(), count: 4 }, "b"),
        ],
        { concurrency: "unbounded" },
      );
      expect(results.flatMap((result) => result.entries)).toHaveLength(5);
      expect(yield* sql`SELECT * FROM persona_assignment`).toHaveLength(5);
      yield* sql`UPDATE discovery_contact SET state = 'review'`;
      expect((yield* store.list).eligibleCount).toBe(0);
      yield* sql`UPDATE discovery_contact SET state = 'failed'`;
      expect(
        (yield* store.select({ requestId: randomUUID(), count: 4 }, "failed-reservations")).entries,
      ).toEqual([]);
    }),
  );
});

test("eligibility excludes blocked, removed, resetting, admitted, pending and unavailable Likes", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const { store, register, sql, profiles } = yield* contactFixture;
      for (const handle of ["blocked", "removed", "reset", "active", "pending", "gone", "ready"])
        yield* register(`${handle}@example.net`, [handle === "gone" ? "missing" : "jiwoo"]);
      yield* register("no-likes@example.net", []);
      yield* sql`INSERT INTO blocked VALUES ('blocked@example.net', 1)`;
      yield* sql`INSERT INTO removal (handle, session_id) VALUES ('removed@example.net', 'old-session')`;
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

test("claiming is idempotent per handle and enforces five assignments", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const { sql } = yield* contactFixture;
      expect(yield* claimPersona("luna", "one@example.net")).toBe(true);
      expect(yield* claimPersona("luna", "one@example.net")).toBe(true);
      expect(yield* claimPersona("luna", "two@example.net")).toBe(true);
      expect(yield* claimPersona("harin", "one@example.net")).toBe(false);
      for (const handle of ["three", "four", "five"])
        expect(yield* claimPersona("luna", handle)).toBe(true);
      expect(yield* claimPersona("luna", "six")).toBe(false);
      expect(yield* claimPersona("luna", "one@example.net")).toBe(true);
      yield* sql`INSERT INTO persona_exclusion VALUES ('six', 'harin')`;
      expect(yield* claimPersona("harin", "six")).toBe(false);
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
      for (let index = 0; index < 4; index++)
        yield* sql`INSERT INTO persona_assignment VALUES ('luna', ${`other${index}`})`;
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
