import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { expect, test } from "vitest";
import { InvitationAccount } from "@ren-ai/onboarding";
import type { InvitationGrant } from "@ren-ai/onboarding";
import { notificationFixture } from "./notifications.test-helper.ts";
import { withContactDatabase } from "./contact.test-helper.ts";
import { invitations } from "./invitations.ts";
import { contactManagement } from "./management.ts";
import { contacts } from "./contacts.ts";

const grant = (
  overrides: Partial<typeof InvitationGrant.Type> = {},
): typeof InvitationGrant.Type => ({
  requestId: randomUUID(),
  handle: "+821011111111",
  kind: "basic",
  locale: "ko",
  ...overrides,
});
const readAccount = (response: Response) =>
  Effect.promise(async () => Schema.decodeUnknownSync(InvitationAccount)(await response.json()));
const manualFixture = Effect.gen(function* () {
  const f = yield* notificationFixture;
  const ledger = yield* invitations;
  const api = contactManagement(f.store, "operator-secret", (event) => f.logs.push(event));
  const call = (action: "grant" | "lookup", body: object, token = "operator-secret") =>
    Effect.promise(() =>
      api(
        new Request(`https://api.test/management/discovery/invitations/${action}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
    );
  const worker = yield* f.reopen(true);
  return { ...f, ledger, call, read: readAccount, worker };
});

test("concurrent operator submissions share one receipt and competing basic requests cannot grant twice", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* manualFixture;
      const input = grant();
      const repeated = yield* Effect.all([f.call("grant", input), f.call("grant", input)], {
        concurrency: 2,
      });
      expect(repeated.map((response) => response.status)).toEqual([200, 200]);
      expect((yield* f.ledger.account(input.handle)).invitations).toHaveLength(2);
      const contenders = yield* Effect.all(
        [
          f.call("grant", grant({ handle: "+821022222222" })),
          f.call("grant", grant({ handle: "+821022222222" })),
        ],
        { concurrency: 2 },
      );
      expect(contenders.map((response) => response.status).toSorted((a, b) => a - b)).toEqual([
        200, 409,
      ]);
      expect((yield* f.ledger.account("+821022222222")).invitations).toHaveLength(2);
    }).pipe(Effect.scoped),
  ));

test("operators grant 2 once and extras individually to an unregistered phone while automatic issuance is OFF", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* manualFixture;
      const input = grant();
      expect((yield* f.call("grant", input, "wrong")).status).toBe(401);
      expect((yield* f.call("grant", { ...input, handle: "invalid" })).status).toBe(400);
      const empty = yield* f.read(yield* f.call("lookup", { handle: input.handle }));
      expect(empty).toEqual({
        handle: input.handle,
        basicGranted: false,
        extraCount: 0,
        invitations: [],
      });
      const first = yield* f.call("grant", input);
      expect(first.status).toBe(200);
      const initial = yield* f.read(first);
      expect(initial).toMatchObject({ basicGranted: true, extraCount: 0 });
      expect(initial.invitations).toHaveLength(2);
      expect(
        yield* f.sql`SELECT id FROM user UNION ALL SELECT id FROM discovery_registration`,
      ).toEqual([]);
      expect(yield* f.read(yield* f.call("grant", input))).toEqual(initial);
      for (const changed of [
        grant(),
        { ...input, kind: "extra" },
        { ...input, handle: "+821022222222" },
        { ...input, locale: "en" },
      ])
        expect((yield* f.call("grant", changed)).status).toBe(409);
      const extra = grant({ kind: "extra", locale: "en" });
      yield* f.call("grant", extra);
      yield* f.call("grant", extra);
      const latest = yield* f.read(yield* f.call("grant", grant({ kind: "extra", locale: "ja" })));
      expect(latest.extraCount).toBe(2);
      expect(latest.invitations).toHaveLength(4);
      expect(yield* f.ledger.settings).toEqual({ enabled: false });
      yield* f.worker.tick;
      expect(f.notify).toHaveBeenCalledTimes(3);
      expect(f.notify.mock.calls[0]![0]).toBe(input.handle);
      expect(
        f.notify.mock.calls
          .map(([, body]) => (body.match(/#invite=/g) ?? []).length)
          .toSorted((a, b) => a - b),
      ).toEqual([1, 1, 2]);
      const delivered = yield* f.ledger.account(input.handle);
      expect(delivered.invitations.every((ticket) => ticket.state === "sent")).toBe(true);
      expect(JSON.stringify(f.logs)).not.toContain(input.handle);
      expect(JSON.stringify(f.logs)).not.toContain(initial.invitations[0]!.token);
    }).pipe(Effect.scoped),
  ));

test("an invitation can be redeemed by its delivery phone without receiving the basic 2 again", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* manualFixture;
      const input = grant();
      const initial = yield* f.read(yield* f.call("grant", input));
      yield* f.ledger.configure(true);
      expect(
        (yield* f.join({ handle: input.handle, invitationToken: initial.invitations[0]!.token }))
          .status,
      ).toBe(200);
      yield* f.worker.tick;
      const result = yield* f.ledger.account(input.handle);
      expect(result.invitations).toHaveLength(2);
      expect(result.invitations.filter((ticket) => ticket.redeemedAt !== null)).toHaveLength(1);
      expect(
        (yield* f.store.list).entries.find((entry) => entry.handle === input.handle)?.state,
      ).toBe("scheduled");
      expect(
        (yield* f.join({ handle: "+821022222222", invitationToken: initial.invitations[0]!.token }))
          .status,
      ).toBe(400);
    }).pipe(Effect.scoped),
  ));

test("manual basics remain available to previously selected Users, and extra-first accounts still receive automatic basics", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* manualFixture;
      const old = yield* f.register("+821011111111");
      const select = (id: string) =>
        f.store.select({ requestId: randomUUID(), count: 1, registrationIDs: [id] }, randomUUID());
      yield* select(old);
      yield* f.call("grant", grant());
      expect((yield* f.ledger.account("+821011111111")).invitations).toHaveLength(2);
      const extra = grant({ handle: "+821022222222", kind: "extra" });
      yield* f.call("grant", extra);
      yield* f.ledger.configure(true);
      const other = yield* f.register(extra.handle);
      yield* select(other);
      const account = yield* f.ledger.account(extra.handle);
      expect(account).toMatchObject({ basicGranted: true, extraCount: 1 });
      expect(account.invitations).toHaveLength(3);
      expect((yield* f.call("grant", grant({ handle: extra.handle }))).status).toBe(409);
      yield* f.sql`INSERT INTO blocked VALUES ('+821033333333', 1)`;
      expect((yield* f.call("grant", grant({ handle: "+821033333333" }))).status).toBe(409);
    }).pipe(Effect.scoped),
  ));

test("a failed issuance rolls back both links, the basic entitlement and the queued delivery with correlated private diagnostics", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* manualFixture;
      const input = grant();
      yield* f.sql`CREATE TRIGGER fail_second_ticket BEFORE INSERT ON invitation
    WHEN (SELECT COUNT(*) FROM invitation WHERE owner = NEW.owner) = 1
    BEGIN SELECT RAISE(ABORT, 'ticket storage failure'); END`;
      const response = yield* f.call("grant", input);
      expect(response.status).toBe(503);
      expect(f.logs).toContainEqual(
        expect.objectContaining({
          requestId: response.headers.get("x-request-id"),
          stage: "invitation_grant.commit",
          outcome: "failed",
          causeName: "ConstraintError",
        }),
      );
      expect((yield* f.ledger.account(input.handle)).invitations).toEqual([]);
      expect(yield* f.sql`SELECT id FROM invitation_delivery`).toEqual([]);
      yield* f.sql`DROP TRIGGER fail_second_ticket`;
      expect((yield* f.read(yield* f.call("grant", input))).invitations).toHaveLength(2);
      const replacement = yield* contacts(async () => f.profiles);
      yield* replacement.grantInvitations(input, randomUUID());
      expect((yield* replacement.invitationAccount(input.handle)).invitations).toHaveLength(2);
      expect(JSON.stringify(f.logs)).not.toContain(input.handle);
      expect(JSON.stringify(f.logs)).not.toContain("operator-secret");
    }).pipe(Effect.scoped),
  ));

test("failed and uncertain manual deliveries retain their links and are never retried by idle workers or replayed submissions", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* manualFixture;
      const input = grant();
      yield* f.call("grant", input);
      f.notify.mockReturnValueOnce(Effect.fail(new Error("transport disconnected")));
      yield* f.worker.tick;
      expect(
        (yield* f.ledger.account(input.handle)).invitations.every(
          (ticket) => ticket.state === "uncertain",
        ),
      ).toBe(true);
      yield* f.worker.tick;
      yield* f.call("grant", input);
      yield* f.worker.tick;
      expect(f.notify).toHaveBeenCalledTimes(1);
      const extra = grant({ kind: "extra" });
      yield* f.call("grant", extra);
      f.availability.mockReturnValueOnce(
        Effect.succeed({ available: false, requestId: randomUUID() }),
      );
      yield* f.worker.tick;
      expect(
        (yield* f.ledger.account(input.handle)).invitations.some(
          (ticket) => ticket.kind === "extra" && ticket.state === "failed",
        ),
      ).toBe(true);
      yield* f.call("grant", grant({ kind: "extra" }));
      f.availability.mockReturnValueOnce(Effect.fail(new Error("availability failed")));
      yield* f.worker.tick;
      const checks = f.availability.mock.calls.length;
      yield* f.worker.tick;
      expect(f.availability).toHaveBeenCalledTimes(checks);
      expect(f.notify).toHaveBeenCalledTimes(1);
    }).pipe(Effect.scoped),
  ));

test("phone lookup stays read-only and returns a bounded indexed history as extra grants grow", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* manualFixture;
      for (let i = 0; i < 52; i++) yield* f.ledger.manual(grant({ kind: "extra" }), randomUUID());
      const read = yield* f.ledger.account("+821011111111");
      expect(read.extraCount).toBe(52);
      expect(read.basicGranted).toBe(false);
      expect(read.invitations).toHaveLength(50);
      expect(yield* f.ledger.account(read.handle)).toEqual(read);
      const plans = yield* f.sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN SELECT i.token FROM invitation i
    JOIN invitation_delivery d ON d.id = i.delivery_id WHERE i.owner = ${read.handle}
    ORDER BY i.created_at DESC, i.token LIMIT 50`;
      expect(plans.map((row) => row.detail).join(" ")).toContain("invitation_owner");
      const queued = yield* f.sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN SELECT id FROM invitation_delivery WHERE state = 'queued' ORDER BY created_at, id LIMIT 30`;
      expect(queued.map((row) => row.detail).join(" ")).toContain("invitation_delivery_queue");
    }).pipe(Effect.scoped),
  ));
