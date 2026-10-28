import { randomUUID } from "node:crypto";
import { Effect, Result } from "effect";
import { expect, test } from "vitest";
import { contactFixture, withContactDatabase } from "./contact.test-helper.ts";
import { contactManagement } from "./management.ts";
import { contacts } from "./contacts.ts";

test("visibility persists across replacement, excludes new selections and starts, and preserves existing reservations", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const f = yield* contactFixture;
      const waiting = yield* f.register("tester@example.net");
      const reserved = yield* f.register("reserved@example.net");
      yield* f.sql`INSERT INTO test_handle VALUES ('tester@example.net')`;
      const selection = yield* f.store.select(
        { requestId: randomUUID(), count: 1, registrationIDs: [reserved] },
        "request",
      );
      const input = { registrationIDs: [waiting, reserved], hidden: true };
      yield* f.store.visibility(input);
      yield* f.store.visibility(input);
      const replacement = yield* contacts(async () => f.profiles);
      const hidden = yield* replacement.list;
      expect(hidden.eligibleCount).toBe(0);
      expect(hidden.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: waiting, hidden: true, eligible: false }),
          expect.objectContaining({
            id: reserved,
            hidden: true,
            state: "scheduled",
            scheduledAt: selection.entries[0]!.scheduledAt,
          }),
        ]),
      );
      expect(
        (yield* replacement.select({ requestId: randomUUID(), count: 100 }, "new")).entries,
      ).toEqual([]);
      expect(
        (yield* replacement.select(
          { requestId: randomUUID(), count: 1, registrationIDs: [waiting] },
          "direct",
        )).entries,
      ).toEqual([]);
      expect(
        yield* replacement.start(
          { requestId: randomUUID(), registrationID: waiting, personaID: "luna" },
          "start",
        ),
      ).toBeNull();
      const assigned = yield* Effect.result(
        replacement.select(
          {
            requestId: randomUUID(),
            count: 1,
            registrationIDs: [waiting],
            assignments: [{ registrationID: waiting, personaID: "luna" }],
          },
          "assigned",
        ),
      );
      expect(Result.isFailure(assigned)).toBe(true);
      yield* replacement.visibility({ registrationIDs: [waiting], hidden: false });
      expect((yield* replacement.list).eligibleCount).toBe(1);
      expect(
        (yield* replacement.start(
          { requestId: randomUUID(), registrationID: waiting, personaID: "luna" },
          "start",
        ))?.entries,
      ).toMatchObject([{ id: waiting, state: "scheduled" }]);
      expect(yield* f.sql`SELECT * FROM persona_assignment`).toHaveLength(2);
      const plan =
        yield* f.sql`EXPLAIN QUERY PLAN UPDATE discovery_registration SET hidden = 1 WHERE id IN (${waiting}, ${reserved}) AND archived_at IS NULL`;
      expect(JSON.stringify(plan)).toContain("USING INDEX");
    }),
  );
});

test("visibility HTTP boundary validates batches, retains archived rows, correlates storage failures and never logs private inputs", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const f = yield* contactFixture;
      const ids = yield* Effect.forEach(
        Array.from({ length: 100 }, (_, i) => `private-${i}@example.net`),
        (handle) => f.register(handle),
      );
      const archived = yield* f.register("archived@example.net");
      yield* f.sql`UPDATE discovery_registration SET archived_at = 1 WHERE id = ${archived}`;
      const events: string[] = [];
      const handler = contactManagement(f.store, "private-token", (event) =>
        events.push(JSON.stringify(event)),
      );
      const call = (body: object, token = "private-token") =>
        handler(
          new Request("https://api.test/management/discovery/visibility", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
          }),
        );
      yield* Effect.promise(async () => {
        expect((await call({ registrationIDs: ids, hidden: true }, "wrong")).status).toBe(401);
        for (const registrationIDs of [
          [],
          ["private-invalid"],
          [ids[0], ids[0]],
          [...ids, archived],
        ])
          expect((await call({ registrationIDs, hidden: true })).status).toBe(400);
        expect((await call({ registrationIDs: ids, hidden: "yes" })).status).toBe(400);
        expect((await call({ registrationIDs: ids, hidden: true })).status).toBe(200);
        expect(
          (await call({ registrationIDs: [archived, randomUUID()], hidden: true })).status,
        ).toBe(200);
      });
      expect((yield* f.store.list).entries.filter((e) => e.hidden)).toHaveLength(100);
      expect(
        yield* f.sql`SELECT hidden FROM discovery_registration WHERE id = ${archived}`,
      ).toEqual([{ hidden: 0 }]);
      yield* f.sql`CREATE TRIGGER visibility_failure BEFORE UPDATE OF hidden ON discovery_registration
        WHEN OLD.handle = 'private-99@example.net' BEGIN SELECT RAISE(ABORT, 'visibility write failed'); END`;
      yield* Effect.promise(async () => {
        const response = await call({ registrationIDs: ids, hidden: false });
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({
          error: "visibility_failed",
          requestId: response.headers.get("x-request-id"),
        });
      });
      expect(events.join("\n")).toContain("visibility.commit");
      expect(events.join("\n")).not.toContain("private-token");
      expect(events.join("\n")).not.toContain("private-invalid");
      expect(events.join("\n")).not.toContain("private-99@example.net");
      expect((yield* f.store.list).entries.every((e) => e.hidden)).toBe(true);
    }),
  );
});

test("concurrent hiding and selection serialize without cancelling committed reservations", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const f = yield* contactFixture;
      for (const hideFirst of [true, false]) {
        const id = yield* f.register(`race-${hideFirst}@example.net`);
        const hide = f.store
          .visibility({ registrationIDs: [id], hidden: true })
          .pipe(Effect.asVoid);
        const select = f.store
          .select({ requestId: randomUUID(), count: 1, registrationIDs: [id] }, "race")
          .pipe(Effect.asVoid);
        yield* Effect.all(hideFirst ? [hide, select] : [select, hide], { concurrency: 2 });
        const snapshot = yield* f.store.list;
        const row = snapshot.entries.find((entry) => entry.id === id)!;
        expect(row.hidden).toBe(true);
        expect(row.eligible).toBe(false);
        expect(
          (yield* f.store.select(
            { requestId: randomUUID(), count: 1, registrationIDs: [id] },
            "after-hide",
          )).entries,
        ).toEqual([]);
        const reservations =
          yield* f.sql`SELECT 1 FROM discovery_contact WHERE registration_id = ${id}`;
        expect(reservations.length).toBe(row.state === "scheduled" ? 1 : 0);
      }
    }),
  );
});
