import { randomUUID } from "node:crypto";
import { Effect, Result, Schema } from "effect";
import { expect, test } from "vitest";
import { InvitationTicket } from "@ren-ai/onboarding";
import { withContactDatabase } from "./contact.test-helper.ts";
import { notificationFixture } from "./notifications.test-helper.ts";
import { attachInvitation, invitations } from "./invitations.ts";
import { contactManagement } from "./management.ts";
import { contacts } from "./contacts.ts";

const input = () => ({ requestId: randomUUID(), maxUses: 20, grantCount: 2 });
const enabledFixture = Effect.gen(function* () {
  const f = yield* notificationFixture;
  const ledger = yield* invitations;
  yield* ledger.configure(true);
  return { ...f, ledger };
});
const request = (body: object, token = "secret") =>
  new Request("https://api.test/management/discovery/invitations/create", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("contact-free codes persist once, reject conflicting requests and case-insensitive names, and list bounded indexed history", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* notificationFixture;
      const ledger = yield* invitations;
      const handler = contactManagement(f.store, "secret", (event) => f.logs.push(event));
      const call = (body: object, token?: string) =>
        Effect.promise(() => handler(request(body, token)));
      const named = { ...input(), code: "THREAD20" };
      expect((yield* call(named, "wrong")).status).toBe(401);
      for (const invalid of [
        { maxUses: 0 },
        { maxUses: 10001 },
        { maxUses: 1.5 },
        { grantCount: -1 },
        { grantCount: 101 },
        { code: "bad code" },
      ])
        expect((yield* call({ ...named, ...invalid })).status).toBe(400);
      const results = yield* Effect.all([call(named), call(named)], { concurrency: 2 });
      expect(results.map((response) => response.status)).toEqual([200, 200]);
      const created = yield* Effect.promise(async () =>
        Schema.decodeUnknownSync(InvitationTicket)(await results[0].json()),
      );
      expect(created).toMatchObject({
        token: "THREAD20",
        maxUses: 20,
        grantCount: 2,
        usedCount: 0,
      });
      const restored = yield* contacts(async () => f.profiles);
      expect(yield* restored.createInvitation(named)).toEqual(created);
      for (const changed of [{ code: "OTHER" }, { maxUses: 3 }, { grantCount: 0 }])
        expect((yield* call({ ...named, ...changed })).status).toBe(409);
      expect((yield* call({ ...named, requestId: randomUUID(), code: "thread20" })).status).toBe(
        409,
      );
      const generatedInput = input();
      const generated = yield* ledger.create(generatedInput);
      expect(generated.token).toMatch(/^[a-f0-9]{64}$/);
      expect(yield* ledger.create(generatedInput)).toEqual(generated);
      expect(
        yield* f.sql`SELECT id FROM user UNION ALL SELECT id FROM discovery_registration UNION ALL SELECT id FROM invitation_delivery`,
      ).toEqual([]);
      for (let i = 0; i < 50; i++) yield* ledger.create(input());
      expect((yield* f.store.list).invitationCodes).toHaveLength(50);
      const plans = yield* f.sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN SELECT token FROM invitation WHERE creation_id IS NOT NULL ORDER BY created_at DESC, token LIMIT 50`;
      expect(plans.map((row) => row.detail).join(" ")).toContain("invitation_created");
      yield* f.sql`CREATE TRIGGER reject_code BEFORE INSERT ON invitation BEGIN SELECT RAISE(ABORT, 'storage failed'); END`;
      const failed = yield* call({ ...input(), code: "PRIVATE_CODE" });
      expect(failed.status).toBe(503);
      expect(f.logs).toContainEqual(
        expect.objectContaining({
          requestId: failed.headers.get("x-request-id"),
          stage: "invitation_create.commit",
          causeName: "ConstraintError",
          outcome: "failed",
        }),
      );
      expect(JSON.stringify(f.logs)).not.toContain("THREAD20");
      expect(JSON.stringify(f.logs)).not.toContain("PRIVATE_CODE");
      expect(JSON.stringify(f.logs)).not.toContain("secret");
    }).pipe(Effect.scoped),
  ));

test("THREAD20 users receive two independent 20-person codes and their children inherit both settings", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* enabledFixture;
      const { ledger } = f;
      yield* ledger.create({ ...input(), code: "THREAD20" });
      const worker = yield* f.reopen(true);
      const join = (handle: string, code: string) => f.join({ handle, invitationToken: code });
      expect((yield* join("+821011111111", "thread20")).status).toBe(200);
      yield* worker.tick;
      const first = yield* ledger.account("+821011111111");
      expect(first.invitations).toHaveLength(2);
      for (const code of first.invitations)
        expect(code).toMatchObject({ maxUses: 20, grantCount: 2, usedCount: 0 });
      yield* join("+821011111111", "THREAD20");
      yield* worker.tick;
      expect((yield* ledger.codes)[0]).toMatchObject({ usedCount: 1 });
      expect((yield* ledger.account(first.handle)).invitations.map((code) => code.token)).toEqual(
        first.invitations.map((code) => code.token),
      );
      yield* join("+821022222222", first.invitations[0]!.token);
      yield* worker.tick;
      const second = yield* ledger.account("+821022222222");
      expect(second.invitations).toHaveLength(2);
      for (const code of second.invitations)
        expect(code).toMatchObject({ maxUses: 20, grantCount: 2, usedCount: 0 });
      yield* join("+821033333333", second.invitations[0]!.token);
      yield* worker.tick;
      expect((yield* ledger.account("+821033333333")).invitations).toHaveLength(2);
      const parent = yield* ledger.account(first.handle);
      expect(parent.invitations.map((code) => code.usedCount!).toSorted((a, b) => a - b)).toEqual([
        0, 1,
      ]);
      expect((yield* ledger.codes)[0]).toMatchObject({ usedCount: 1 });
      expect(
        yield* f.sql`SELECT parent_token FROM invitation WHERE owner = '+821033333333'`,
      ).toEqual([
        { parent_token: second.invitations[0]!.token },
        { parent_token: second.invitations[0]!.token },
      ]);
    }).pipe(Effect.scoped),
  ));

test("the last shared-code slot is atomic, losing selections roll back, and each child has its own full capacity", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* enabledFixture;
      const { ledger } = f;
      const root = yield* ledger.create({ ...input(), code: "LAST2", maxUses: 2, grantCount: 1 });
      const a = yield* f.register("+821011111111");
      const b = yield* f.register("+821022222222");
      const c = yield* f.register("+821033333333");
      for (const [id, handle] of [
        [a, "+821011111111"],
        [b, "+821022222222"],
        [c, "+821033333333"],
      ])
        yield* attachInvitation(id!, root.token.toLowerCase(), handle!);
      const select = (id: string) =>
        f.store.select({ requestId: randomUUID(), count: 1, registrationIDs: [id] }, randomUUID());
      yield* select(a);
      const competing = yield* Effect.all([Effect.result(select(b)), Effect.result(select(c))], {
        concurrency: 2,
      });
      expect(competing.filter(Result.isSuccess)).toHaveLength(1);
      expect(competing.filter(Result.isFailure)).toHaveLength(1);
      expect((yield* ledger.codes)[0]).toMatchObject({ usedCount: 2, maxUses: 2 });
      expect(yield* f.sql`SELECT handle FROM persona_assignment`).toHaveLength(2);
      expect(yield* f.sql`SELECT handle FROM invitation_redemption`).toHaveLength(2);
      expect(yield* f.sql`SELECT token FROM invitation WHERE owner IS NOT NULL`).toHaveLength(2);
      expect((yield* f.join({ handle: "+821044444444", invitationToken: root.token })).status).toBe(
        400,
      );
      expect((yield* f.join({ handle: "+821011111111", invitationToken: root.token })).status).toBe(
        200,
      );
      const child = (yield* ledger.account("+821011111111")).invitations[0]!;
      const d = yield* f.register("+821055555555");
      const e = yield* f.register("+821066666666");
      for (const [id, handle] of [
        [d, "+821055555555"],
        [e, "+821066666666"],
      ]) {
        yield* attachInvitation(id!, child.token, handle!);
        yield* select(id!);
      }
      expect((yield* ledger.account("+821011111111")).invitations[0]).toMatchObject({
        usedCount: 2,
        maxUses: 2,
        grantCount: 1,
      });
      expect((yield* ledger.codes)[0]).toMatchObject({ usedCount: 2 });
    }).pipe(Effect.scoped),
  ));

test("zero grants stop propagation, OFF never backfills, and manual code settings survive request replay", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* enabledFixture;
      const { ledger } = f;
      const root = yield* ledger.create({ ...input(), grantCount: 0 });
      yield* f.join({ invitationToken: root.token });
      const worker = yield* f.reopen(true);
      yield* worker.tick;
      expect((yield* ledger.account("+821012345678")).invitations).toEqual([]);
      expect(yield* f.sql`SELECT id FROM invitation_delivery WHERE state = 'queued'`).toEqual([]);
      expect(f.notify).toHaveBeenCalledTimes(1);
      yield* ledger.configure(false);
      const off = yield* ledger.create(input());
      yield* f.join({ handle: "+821022222222", invitationToken: off.token });
      yield* worker.tick;
      yield* ledger.configure(true);
      yield* ledger.grant("+821022222222", "not-backfilled");
      expect((yield* ledger.account("+821022222222")).invitations).toEqual([]);
      const manual = {
        requestId: randomUUID(),
        handle: "+821033333333",
        kind: "extra" as const,
        locale: "en" as const,
        maxUses: 3,
        grantCount: 0,
      };
      const issued = yield* ledger.manual(manual, "manual");
      expect(issued.invitations[0]).toMatchObject({ maxUses: 3, grantCount: 0, usedCount: 0 });
      expect(yield* ledger.manual(manual, "replay")).toEqual(issued);
      for (const changed of [{ maxUses: 4 }, { grantCount: 2 }])
        expect(
          Result.isFailure(
            yield* Effect.result(ledger.manual({ ...manual, ...changed }, "conflict")),
          ),
        ).toBe(true);
    }).pipe(Effect.scoped),
  ));

test("a consented submission can remove or replace its pending code without spending either code", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* enabledFixture;
      const first = yield* f.ledger.create({ ...input(), code: "FIRST" });
      const second = yield* f.ledger.create({ ...input(), code: "SECOND" });
      yield* f.join({ invitationToken: first.token });
      yield* f.join();
      const worker = yield* f.reopen(true);
      yield* worker.tick;
      expect(yield* f.sql`SELECT * FROM invitation_submission`).toEqual([]);
      expect(yield* f.sql`SELECT * FROM invitation_redemption`).toEqual([]);
      yield* f.join({ invitationToken: first.token });
      yield* f.join({ invitationToken: second.token });
      yield* worker.tick;
      expect(yield* f.sql`SELECT token FROM invitation_redemption`).toEqual([{ token: "SECOND" }]);
      expect((yield* f.ledger.codes).find((code) => code.token === "FIRST")).toMatchObject({
        usedCount: 0,
      });
      yield* f.join();
      expect(yield* f.sql`SELECT token FROM invitation_submission`).toEqual([{ token: "SECOND" }]);
    }).pipe(Effect.scoped),
  ));
