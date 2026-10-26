import { randomUUID } from "node:crypto";
import { Effect, Result } from "effect";
import { expect, test } from "vitest";
import { contactFixture, withContactDatabase } from "./contact.test-helper.ts";
import { notificationFixture } from "./notifications.test-helper.ts";
import { attachInvitation, invitations } from "./invitations.ts";
import { contacts } from "./contacts.ts";
import { waitlistNotifications } from "./notifications.ts";
import { contactManagement } from "./management.ts";

const select = (id: string) => ({ requestId: randomUUID(), count: 1, registrationIDs: [id] });
const viralFixture = Effect.gen(function* () {
  const f = yield* notificationFixture;
  const invites = yield* invitations;
  yield* invites.configure(true);
  const owner = yield* f.register("+821011111111");
  yield* f.store.select(select(owner), "owner");
  const tickets = yield* invites.list;
  const reopen = () =>
    waitlistNotifications(
      { notify: f.notify, notificationStatus: f.notificationStatus, availability: f.availability },
      (event) => f.logs.push(event),
      async () => f.profiles,
    );
  return { ...f, invites, tickets, reopen, worker: yield* reopen() };
});

test("issuance defaults off, grants once at first selection, and never backfills or repeats across actor replacement", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* contactFixture;
      const invites = yield* invitations;
      expect(yield* invites.settings).toEqual({ enabled: false });
      const before = yield* f.register("before");
      const oldRequest = select(before);
      yield* f.store.select(oldRequest, "first");
      yield* invites.configure(true);
      yield* f.store.select(oldRequest, "retry-after-on");
      expect(yield* invites.list).toEqual([]);
      const owner = yield* f.register("owner");
      const request = select(owner);
      yield* f.store.select(request, "initial");
      const issued = yield* invites.list;
      expect(issued).toHaveLength(2);
      expect(new Set(issued.map((row) => row.token)).size).toBe(2);
      expect(
        issued.every((row) => /^[a-f0-9]{64}$/.test(row.token) && row.redeemedAt === null),
      ).toBe(true);
      const reopened = yield* contacts(async () => f.profiles);
      yield* reopened.select(request, "retry-after-restart");
      yield* invites.grant("owner", "duplicate");
      expect(yield* invites.list).toEqual(issued);
      yield* invites.grant("before", "before");
      expect(yield* invites.list).toEqual(issued);
      const { invitationSettings, entries } = yield* reopened.list;
      expect(invitationSettings).toEqual({ enabled: true });
      expect(entries.find((row) => row.id === owner)?.invitations).toHaveLength(2);
      const notifications = yield* f.sql<{
        text: string;
      }>`SELECT invitation_text AS text FROM discovery_notification WHERE invitation_text IS NOT NULL`;
      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.text).toContain("https://renai.im/explore#invite=");
      yield* invites.configure(false);
      const after = yield* f.register("after");
      yield* reopened.select(select(after), "after");
      expect(yield* invites.list).toEqual(issued);
    }).pipe(Effect.scoped),
  ));

test("valid invitations auto-select after availability, propagate while on, and remain redeemable while off", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* viralFixture;
      const {
        invites,
        worker,
        tickets: [first, second],
      } = f;
      expect(
        (yield* f.join({ handle: "+821022222222", invitationToken: first!.token })).status,
      ).toBe(200);
      expect(
        (yield* f.join({ handle: "+821022222222", invitationToken: first!.token })).status,
      ).toBe(200);
      yield* worker.tick;
      let rows = yield* f.store.list;
      const friend = rows.entries.find((row) => row.handle === "+821022222222")!;
      expect(friend.state).toBe("scheduled");
      expect(friend.invitations).toHaveLength(2);
      expect(
        f.notify.mock.calls.filter(([, text]) => text.includes("invitation has been used")),
      ).toHaveLength(1);
      expect((yield* invites.list).find((row) => row.token === first!.token)?.redeemedAt).toEqual(
        expect.any(Number),
      );
      yield* f.join({ handle: "+821022222222", invitationToken: first!.token });
      yield* worker.tick;
      expect(
        f.notify.mock.calls.filter(([, text]) => text.includes("invitation has been used")),
      ).toHaveLength(1);
      yield* invites.configure(false);
      expect(
        (yield* f.join({ handle: "+821033333333", invitationToken: second!.token })).status,
      ).toBe(200);
      yield* worker.tick;
      rows = yield* f.store.list;
      expect(rows.invitationSettings.enabled).toBe(false);
      expect(rows.entries.find((row) => row.handle === "+821033333333")).toMatchObject({
        state: "scheduled",
        invitations: [],
      });
      expect(
        (yield* invites.list).filter(
          (row) => row.owner === "+821011111111" && row.redeemedAt === null,
        ),
      ).toHaveLength(0);
      expect(
        (yield* f.join({ handle: "+821044444444", invitationToken: second!.token })).status,
      ).toBe(400);
      expect(JSON.stringify(f.logs)).not.toContain(first!.token);
      expect(JSON.stringify(f.logs)).not.toContain("+821022222222");
    }).pipe(Effect.scoped),
  ));

test("invalid, self and conflicting uses cannot spend an invitation or partially reserve a persona", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* viralFixture;
      const {
        invites,
        tickets: [ticket],
      } = f;
      for (const input of [
        { handle: "+821022222222", invitationToken: "0".repeat(64) },
        { handle: "+821011111111", invitationToken: ticket!.token },
      ]) {
        const response = yield* f.join(input);
        expect(response.status).toBe(400);
        expect(yield* Effect.promise(() => response.json())).toBe("invitation");
      }
      expect(
        yield* f.sql`SELECT id FROM discovery_registration WHERE handle = '+821022222222'`,
      ).toEqual([]);
      const a = yield* f.register("a");
      const b = yield* f.register("b");
      yield* attachInvitation(a, ticket!.token, "a");
      yield* attachInvitation(b, ticket!.token, "b");
      yield* f.store.select(select(a), "winner");
      const loser = yield* Effect.result(f.store.select(select(b), "loser"));
      expect(Result.isFailure(loser)).toBe(true);
      expect(yield* f.sql`SELECT handle FROM persona_assignment WHERE handle = 'b'`).toEqual([]);
      expect(
        yield* f.sql`SELECT registration_id FROM discovery_contact WHERE registration_id = ${b}`,
      ).toEqual([]);
      const spent = (yield* invites.list).find((row) => row.token === ticket!.token)!;
      expect(spent.redeemedAt).not.toBeNull();
    }).pipe(Effect.scoped),
  ));

test("the authenticated management boundary persists issuance independently of selection and diagnoses storage failures", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* contactFixture;
      const logs: object[] = [];
      const handler = contactManagement(f.store, "secret", (event) => logs.push(event));
      const call = (body: object, token = "secret") =>
        Effect.promise(() =>
          handler(
            new Request("https://api.test/management/discovery/invitations", {
              method: "POST",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
          ),
        );

      expect((yield* call({ enabled: true }, "wrong")).status).toBe(401);
      expect((yield* call({ enabled: "true" })).status).toBe(400);
      expect((yield* call({ enabled: true })).status).toBe(200);
      yield* f.sql`CREATE TRIGGER reject_invitation_setting BEFORE UPDATE ON invitation_settings BEGIN SELECT RAISE(ABORT, 'setting failure'); END`;
      const response = yield* call({ enabled: false });
      expect(response.status).toBe(503);
      expect(logs).toContainEqual(
        expect.objectContaining({
          requestId: response.headers.get("x-request-id"),
          stage: "invitations.commit",
          outcome: "failed",
          causeName: "ConstraintError",
        }),
      );
      expect((yield* f.store.list).invitationSettings).toEqual({ enabled: true });
    }).pipe(Effect.scoped),
  ));

test("a failed iMessage lookup is retried only by a fresh invitation submission", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* viralFixture;
      const {
        invites,
        worker,
        tickets: [ticket],
      } = f;
      yield* invites.configure(false);
      yield* f.join({ invitationToken: ticket!.token });
      f.availability.mockReturnValueOnce(Effect.fail(new Error("lookup failed")));
      // The owner fixture is already verified; only the invited registration calls availability.
      yield* worker.tick;
      expect(
        (yield* f.store.list).entries.find((row) => row.handle === "+821012345678")?.state,
      ).toBe("waiting");
      expect(
        (yield* invites.list).find((row) => row.token === ticket!.token)?.redeemedAt,
      ).toBeNull();
      const checks = f.availability.mock.calls.length;
      yield* worker.tick;
      expect(f.availability).toHaveBeenCalledTimes(checks);
      yield* f.join({ invitationToken: ticket!.token });
      yield* worker.tick;
      expect(f.availability).toHaveBeenCalledTimes(checks + 1);
      expect(
        (yield* f.store.list).entries.find((row) => row.handle === "+821012345678")?.state,
      ).toBe("scheduled");
    }).pipe(Effect.scoped),
  ));

test("actor replacement after selection commits retains the selected notification and never spends or grants twice", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* viralFixture;
      const {
        invites,
        tickets: [ticket],
      } = f;
      yield* f.join({ invitationToken: ticket!.token });
      yield* f.sql`CREATE TRIGGER interrupt_before_notification BEFORE UPDATE OF state ON discovery_notification
      WHEN NEW.state = 'uncertain' AND NEW.invitation_text IS NULL
      BEGIN SELECT RAISE(ABORT, 'interrupted claim'); END`;
      yield* f.worker.tick;
      expect(f.logs).toContainEqual(
        expect.objectContaining({
          stage: "notification.claim",
          outcome: "failed",
          causeName: "ConstraintError",
        }),
      );
      const issued = yield* invites.list;
      expect(issued).toHaveLength(4);
      yield* f.sql`DROP TRIGGER interrupt_before_notification`;
      const restored = yield* f.reopen();
      yield* restored.tick;
      expect(yield* invites.list).toEqual(issued);
      expect(
        f.notify.mock.calls.filter(
          ([handle, text]) =>
            handle === "+821012345678" && text.includes("invitation has been used"),
        ),
      ).toHaveLength(1);
      expect(JSON.stringify(f.logs)).not.toContain(ticket!.token);
    }).pipe(Effect.scoped),
  ));
