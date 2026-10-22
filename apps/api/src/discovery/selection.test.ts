import { randomUUID } from "node:crypto";
import { Effect, Result } from "effect";
import { expect, test } from "vitest";
import { contactFixture, withContactDatabase } from "./contact.test-helper.ts";
import { contacts } from "./contacts.ts";
import { contactManagement } from "./management.ts";
import type { ContactDiagnostic } from "./diagnostics.ts";

test("explicit Like assignments are reserved before random choices and retry targets survive replacement", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* contactFixture;
      for (let index = 0; index < 4; index++) {
        yield* f.sql`INSERT INTO persona_assignment VALUES ('luna', ${`luna${index}@example.net`})`;
        yield* f.sql`INSERT INTO persona_assignment VALUES ('harin', ${`harin${index}@example.net`})`;
      }
      const random = yield* f.register("random@example.net", ["luna", "harin"]);
      const fixed = yield* f.register("fixed@example.net", ["luna", "harin"]);
      const input = {
        requestId: randomUUID(),
        count: 2,
        registrationIDs: [random, fixed],
        assignments: [{ registrationID: fixed, personaID: "luna" }],
      };
      const before = Date.now();
      const selected = yield* f.store.select(input, "fixed-request");
      expect(selected.entries.find((row) => row.id === fixed)?.persona?.id).toBe("luna");
      expect(selected.entries.find((row) => row.id === random)?.persona?.id).toBe("harin");
      for (const row of selected.entries) {
        expect(row.scheduledAt).toBeGreaterThanOrEqual(before + 300_000);
        expect(row.scheduledAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
        expect(row.assignablePersonas).toEqual([]);
      }
      const restarted = yield* contacts(async () => f.profiles);
      expect(
        yield* restarted.select({ ...input, registrationIDs: [fixed, random] }, "retry"),
      ).toEqual(selected);
      for (const changed of [
        { ...input, count: 1 },
        { ...input, registrationIDs: [fixed, randomUUID()] },
        { ...input, assignments: [{ registrationID: fixed, personaID: "harin" }] },
        { requestId: input.requestId, count: 2 },
      ])
        expect(Result.isFailure(yield* Effect.result(restarted.select(changed, "conflict")))).toBe(
          true,
        );
      expect(yield* f.sql`SELECT 1 FROM discovery_contact`).toHaveLength(2);
    }),
  ));

test("designated candidates must be eligible, selected, published Likes with remaining capacity", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* contactFixture;
      const first = yield* f.register("first@example.net", ["luna", "harin"]);
      const second = yield* f.register("second@example.net", ["luna", "harin"]);
      const held = yield* f.register("held@example.net", ["luna"]);
      yield* f.sql`INSERT INTO blocked VALUES ('held@example.net', 1)`;
      const missing = randomUUID();
      const base = { requestId: randomUUID(), count: 3, registrationIDs: [first, second, held] };
      for (const assignments of [
        [{ registrationID: first, personaID: "jiwoo" }],
        [{ registrationID: first, personaID: "unpublished" }],
        [{ registrationID: held, personaID: "luna" }],
        [{ registrationID: missing, personaID: "luna" }],
        [
          { registrationID: first, personaID: "luna" },
          { registrationID: first, personaID: "harin" },
        ],
      ])
        expect(
          Result.isFailure(
            yield* Effect.result(f.store.select({ ...base, assignments }, "invalid")),
          ),
        ).toBe(true);
      expect(
        Result.isFailure(
          yield* Effect.result(
            f.store.select(
              {
                ...base,
                registrationIDs: [first, second, missing],
                assignments: [{ registrationID: missing, personaID: "luna" }],
              },
              "missing",
            ),
          ),
        ),
      ).toBe(true);
      expect(
        Result.isFailure(
          yield* Effect.result(
            f.store.select(
              {
                requestId: randomUUID(),
                count: 1,
                assignments: [{ registrationID: first, personaID: "luna" }],
              },
              "unchecked",
            ),
          ),
        ),
      ).toBe(true);
      for (let index = 0; index < 5; index++)
        yield* f.sql`INSERT INTO persona_assignment VALUES ('luna', ${`already${index}@example.net`})`;
      const listing = yield* f.store.list;
      expect(listing.entries.find((row) => row.id === first)?.assignablePersonas).toEqual([
        { id: "harin", name: "harin" },
      ]);
      expect(
        Result.isFailure(
          yield* Effect.result(
            f.store.select(
              { ...base, assignments: [{ registrationID: first, personaID: "luna" }] },
              "occupied",
            ),
          ),
        ),
      ).toBe(true);
      expect(yield* f.sql`SELECT 1 FROM discovery_selection`).toEqual([]);
      expect(yield* f.sql`SELECT 1 FROM discovery_contact`).toEqual([]);
      yield* f.sql`DELETE FROM persona_assignment`;
      const assignments = [
        { registrationID: first, personaID: "luna" },
        { registrationID: second, personaID: "luna" },
      ];
      const input = {
        requestId: randomUUID(),
        count: 2,
        registrationIDs: [first, second],
        assignments,
      };
      const selected = yield* f.store.select(input, "two-fixed");
      expect(selected.entries).toHaveLength(2);
      expect(selected.entries.every((row) => row.persona?.id === "luna")).toBe(true);
      expect(
        yield* f.store.select({ ...input, assignments: assignments.toReversed() }, "retry"),
      ).toEqual(selected);
    }),
  ));

test("a racing explicit claim rolls back the entire selection and its retry identity", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* contactFixture;
      const id = yield* f.register("one@example.net", ["luna"]);
      for (let index = 0; index < 4; index++)
        yield* f.sql`INSERT INTO persona_assignment VALUES ('luna', ${`already${index}@example.net`})`;
      yield* f.sql`CREATE TRIGGER concurrent_assignment AFTER INSERT ON discovery_selection
      BEGIN INSERT INTO persona_assignment VALUES ('luna', 'winner@example.net'); END`;
      const input = {
        requestId: randomUUID(),
        count: 1,
        registrationIDs: [id],
        assignments: [{ registrationID: id, personaID: "luna" }],
      };
      expect(Result.isFailure(yield* Effect.result(f.store.select(input, "racing")))).toBe(true);
      expect(yield* f.sql`SELECT 1 FROM discovery_selection`).toEqual([]);
      expect(yield* f.sql`SELECT 1 FROM persona_assignment`).toHaveLength(4);
      yield* f.sql`DROP TRIGGER concurrent_assignment`;
      expect((yield* f.store.select(input, "retry")).entries[0]?.persona?.id).toBe("luna");
    }),
  ));

test.each(["scheduled", "review", "failed"])(
  "%s reservations count toward explicit-choice capacity and cannot be reassigned",
  (state) =>
    withContactDatabase(
      Effect.gen(function* () {
        const f = yield* contactFixture;
        for (let index = 0; index < 4; index++) yield* f.register(`reserved${index}@example.net`);
        const reserved = yield* f.store.select({ requestId: randomUUID(), count: 4 }, "reserve");
        yield* f.sql`UPDATE discovery_contact SET state = ${state}`;
        const first = yield* f.register("first@example.net", ["luna", "harin"]);
        const second = yield* f.register("second@example.net", ["luna", "harin"]);
        const input = {
          requestId: randomUUID(),
          count: 2,
          registrationIDs: [first, second],
          assignments: [
            { registrationID: first, personaID: "luna" },
            { registrationID: second, personaID: "luna" },
          ],
        };
        expect(Result.isFailure(yield* Effect.result(f.store.select(input, "over-capacity")))).toBe(
          true,
        );
        const held = reserved.entries[0]!;
        expect(
          Result.isFailure(
            yield* Effect.result(
              f.store.select(
                {
                  requestId: randomUUID(),
                  count: 1,
                  registrationIDs: [held.id],
                  assignments: [{ registrationID: held.id, personaID: "luna" }],
                },
                "already-reserved",
              ),
            ),
          ),
        ).toBe(true);
        expect(yield* f.sql`SELECT 1 FROM discovery_selection`).toHaveLength(1);
        expect(yield* f.sql`SELECT 1 FROM persona_assignment`).toHaveLength(4);
        const selected = yield* f.store.select(
          { ...input, assignments: [{ registrationID: first, personaID: "luna" }] },
          "last-slot",
        );
        expect(selected.entries.find((row) => row.id === first)?.persona?.id).toBe("luna");
        expect(selected.entries.find((row) => row.id === second)?.persona?.id).toBe("harin");
        expect(
          yield* f.sql`SELECT 1 FROM persona_assignment WHERE persona_id = 'luna'`,
        ).toHaveLength(5);
      }),
    ),
);

test("a permanent relationship exclusion rejects only that handle's explicit choice", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* contactFixture;
      const ended = yield* f.register("ended@example.net", ["luna", "harin"]);
      const other = yield* f.register("other@example.net", ["luna"]);
      yield* f.sql`INSERT INTO persona_exclusion VALUES ('ended@example.net', 'luna')`;
      const input = {
        requestId: randomUUID(),
        count: 2,
        registrationIDs: [ended, other],
        assignments: [
          { registrationID: ended, personaID: "luna" },
          { registrationID: other, personaID: "luna" },
        ],
      };
      expect(Result.isFailure(yield* Effect.result(f.store.select(input, "excluded")))).toBe(true);
      expect(yield* f.sql`SELECT 1 FROM persona_assignment`).toEqual([]);
      expect(
        (yield* f.store.list).entries.find((row) => row.id === ended)?.assignablePersonas,
      ).toEqual([{ id: "harin", name: "harin" }]);
      const selected = yield* f.store.select(
        { ...input, assignments: [{ registrationID: other, personaID: "luna" }] },
        "per-handle",
      );
      expect(selected.entries.find((row) => row.id === ended)?.persona?.id).toBe("harin");
      expect(selected.entries.find((row) => row.id === other)?.persona?.id).toBe("luna");
    }),
  ));

test("the authenticated assignment endpoint rejects missing plans and diagnoses conflicts without private registration data", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* contactFixture;
      const id = yield* f.register("private@example.net", ["luna"]);
      const logs: ContactDiagnostic[] = [];
      const handler = contactManagement(f.store, "secret-token", (event) => logs.push(event));
      const input = { requestId: randomUUID(), count: 1, registrationIDs: [id] };
      const post = (body: object) =>
        Effect.promise(() =>
          handler(
            new Request("https://api.test/management/discovery/select-assigned", {
              method: "POST",
              headers: { authorization: "Bearer secret-token" },
              body: JSON.stringify(body),
            }),
          ),
        );
      expect((yield* post(input)).status).toBe(400);
      const conflict = yield* post({
        ...input,
        assignments: [{ registrationID: id, personaID: "harin" }],
      });
      expect(conflict.status).toBe(409);
      expect(logs.find((event) => event.stage === "selection.commit")).toMatchObject({
        requestId: conflict.headers.get("x-request-id"),
        level: "warn",
        outcome: "failed",
        causeName: "SelectionConflict",
      });
      expect(JSON.stringify(logs)).not.toMatch(/private@example|secret-token/);
      const accepted = yield* post({
        ...input,
        assignments: [{ registrationID: id, personaID: "luna" }],
      });
      expect(accepted.status).toBe(200);
      expect(
        (yield* post({ ...input, assignments: [{ registrationID: id, personaID: "harin" }] }))
          .status,
      ).toBe(409);
    }),
  ));
