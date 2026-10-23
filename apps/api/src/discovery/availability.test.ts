import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { withContactDatabase } from "./contact.test-helper.ts";
import { notificationFixture } from "./notifications.test-helper.ts";
import { checkAvailability } from "./availability.ts";

const assertSelectionHeld = (
  f: Effect.Success<typeof notificationFixture>,
  row: { id: string; handle: string },
) =>
  Effect.gen(function* () {
    yield* f.sql`INSERT INTO test_handle VALUES (${row.handle})`;
    expect(
      yield* f.store.start(
        { requestId: randomUUID(), registrationID: row.id, personaID: "luna" },
        "start",
      ),
    ).toBeNull();
    for (const registrationIDs of [undefined, [row.id]]) {
      const result = yield* f.store.select(
        { requestId: randomUUID(), count: 1, ...(registrationIDs && { registrationIDs }) },
        "selection",
      );
      expect(result.entries).toEqual([]);
    }
    expect(yield* f.sql`SELECT * FROM persona_assignment`).toEqual([]);
    expect(yield* f.sql`SELECT * FROM discovery_contact`).toEqual([]);
    expect(yield* f.sql`SELECT * FROM discovery_like`).toHaveLength(1);
  });

test.each(["unchecked", "failed"])(
  "%s iMessage lookup holds all Selection paths until confirmed",
  (status) =>
    withContactDatabase(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* notificationFixture;
          yield* f.join();
          if (status === "failed") {
            f.availability.mockReturnValue(Effect.fail(new Error("Lookup unavailable")));
            yield* f.tick;
          }
          const row = (yield* f.store.list).entries[0]!;
          expect(row.eligible).toBe(false);
          expect(row.reason).toBe("imessage_unverified");
          expect((yield* f.store.list).eligibleCount).toBe(0);
          yield* assertSelectionHeld(f, row);
          yield* f.sql`UPDATE discovery_registration SET imessage_status = 'available', imessage_checked_at = 123 WHERE id = ${row.id}`;
          expect((yield* f.store.list).entries[0]).toMatchObject({
            eligible: true,
            reason: "ready",
          });
          expect(
            (yield* f.store.select(
              { requestId: randomUUID(), count: 1, registrationIDs: [row.id] },
              "confirmed",
            )).entries,
          ).toHaveLength(1);
        }),
      ),
    ),
);

test.each([true, false])(
  "lookup available=%s is durable and controls every Selection path without a send",
  (available) =>
    withContactDatabase(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* notificationFixture;
          f.availability.mockReturnValue(
            Effect.succeed({ available, requestId: "lookup-request" }),
          );
          yield* f.join();
          yield* f.tick;
          yield* (yield* f.reopen()).tick;
          expect(f.availability).toHaveBeenCalledExactlyOnceWith("+821012345678");
          expect(f.notify).toHaveBeenCalledTimes(available ? 1 : 0);
          const { entries } = yield* f.store.list;
          const row = entries[0]!;
          yield* checkAvailability(row.id, { availability: f.availability }, (event) =>
            f.logs.push(event),
          );
          expect(f.availability).toHaveBeenCalledTimes(1);
          expect(row).toMatchObject({
            eligible: available,
            reason: available ? "ready" : "no_imessage",
            imessage: {
              status: available ? "available" : "unavailable",
            },
          });
          expect(row.imessage?.checkedAt).toEqual(expect.any(Number));
          if (!available) {
            yield* assertSelectionHeld(f, row);
            expect(yield* f.sql`SELECT * FROM notification_attempt`).toEqual([]);
          }
          expect(f.logs).toContainEqual(
            expect.objectContaining({
              operation: "recipient.availability",
              operationId: "lookup-request",
              stage: "complete",
            }),
          );
        }),
      ),
    ),
);

test.each([undefined, "upstream-request"])(
  "lookup failure (%s) is recorded separately with safe correlated diagnostics",
  (requestId) =>
    withContactDatabase(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* notificationFixture;
          f.availability.mockReturnValue(
            Effect.fail(
              Object.assign(new Error("private +821012345678 secret-token"), {
                code: "ECONNRESET",
                ...(requestId !== undefined && { requestId }),
              }),
            ),
          );
          yield* f.join();
          yield* f.tick;
          expect((yield* f.store.list).entries[0]).toMatchObject({
            eligible: false,
            reason: "imessage_unverified",
            imessage: { status: "failed" },
          });
          expect(f.logs).toContainEqual(
            expect.objectContaining({
              operation: "recipient.availability",
              stage: "transport.lookup",
              causeCode: "ECONNRESET",
              level: "error",
            }),
          );
          const failure = f.logs.find((event) => event.stage === "transport.lookup")!;
          expect(failure.operationId).toBe(typeof requestId === "string" ? requestId : undefined);
          expect(failure.requestId).not.toBe((yield* f.store.list).entries[0]!.id);
          expect(JSON.stringify(f.logs)).not.toMatch(/821012345678|secret-token|private/);
        }),
      ),
    ),
);

test("lookup is performed even when the Notification cap is exhausted; removed registrations are ignored", () =>
  withContactDatabase(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* notificationFixture;
        yield* f.exhaustBudget;
        yield* f.join();
        yield* f.tick;
        expect((yield* f.store.list).entries[0]).toMatchObject({
          notification: "skipped",
          imessage: { status: "available" },
        });
        expect(f.notify).not.toHaveBeenCalled();
      }),
    ),
  ));
