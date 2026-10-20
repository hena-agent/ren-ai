import { Effect } from "effect";
import { expect, test } from "vitest";
import { withContactDatabase } from "./contact.test-helper.ts";
import { notificationFixture } from "./notifications.test-helper.ts";

const submitAndRestart = (f: Effect.Success<typeof notificationFixture>) =>
  Effect.gen(function* () {
    yield* f.join();
    yield* f.tick;
    yield* (yield* f.reopen()).tick;
    expect(f.notify).toHaveBeenCalledTimes(1);
  });

test("joining queues one Notification in the consent language without starting a Conversation", () =>
  withContactDatabase(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* notificationFixture;
        for (let repeat = 0; repeat < 2; repeat++) {
          const response = yield* f.join();
          expect(response.status).toBe(200);
          expect(yield* Effect.promise(() => response.json())).toEqual({ status: "waiting" });
        }
        expect(f.notify).not.toHaveBeenCalled();
        expect(yield* f.snapshot).toMatchObject({
          entries: [{ notification: "queued", eligible: false, reason: "imessage_unverified" }],
        });
        yield* f.tick;
        yield* f.tick;
        expect(f.notify).toHaveBeenCalledExactlyOnceWith(
          "+821012345678",
          "[Ren AI] This number has joined the Ren AI waitlist. There's no set order or date for contact. If you're selected, a persona you liked will text you from hi@renai.im. This address only sends notifications and doesn't read replies. To leave the waitlist, or if you didn't sign up, email hi@renai.im.",
        );
        expect(yield* f.snapshot).toMatchObject({
          entries: [{ notification: "sent", eligible: true }],
        });
        expect(yield* f.sql`SELECT id FROM conversation`).toEqual([]);
        expect(yield* f.sql`SELECT id FROM send`).toEqual([]);
      }),
    ),
  ));

test("the rolling service-wide cap skips excess joins permanently and survives deletion and worker replacement", () =>
  withContactDatabase(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* notificationFixture;
        for (let index = 0; index < 32; index++)
          expect(
            (yield* f.join({ handle: `+82101234${String(index).padStart(4, "0")}` })).status,
          ).toBe(200);
        yield* f.tick;
        yield* (yield* f.reopen()).tick;
        expect(f.notify).toHaveBeenCalledTimes(30);
        expect(
          yield* f.sql`SELECT state, COUNT(*) AS count FROM discovery_notification GROUP BY state ORDER BY state`,
        ).toEqual([
          { state: "sent", count: 30 },
          { state: "skipped", count: 2 },
        ]);
        yield* f.sql`DELETE FROM discovery_registration WHERE id IN (SELECT registration_id FROM discovery_notification WHERE state = 'sent')`;
        yield* f.join({ handle: "+821099990000" });
        yield* (yield* f.reopen()).tick;
        expect(f.notify).toHaveBeenCalledTimes(30);
        yield* f.sql`UPDATE notification_attempt SET at = at - 3600000`;
        yield* f.join({ handle: "+821099990001" });
        yield* f.tick;
        expect(f.notify).toHaveBeenCalledTimes(31);
        expect(
          yield* f.sql`SELECT COUNT(*) AS count FROM discovery_notification WHERE state = 'skipped'`,
        ).toEqual([{ count: 3 }]);
        expect(yield* f.sql`SELECT COUNT(*) AS count FROM notification_attempt`).toEqual([
          { count: 1 },
        ]);
      }),
    ),
  ));

test.each([
  {
    locale: "ko" as const,
    phrase: "이 번호로 Ren AI 대기 등록이 완료되었습니다.",
    email: "이메일을 보내 주세요.",
  },
  {
    locale: "ja" as const,
    phrase: "この番号でRen AIのウェイトリストへの登録が完了しました。",
    email: "メールをお送りください。",
  },
])(
  "$locale uses display/consent language rather than preferred Conversation language",
  ({ locale, phrase, email }) =>
    withContactDatabase(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* notificationFixture;
          yield* f.join({ locale, conversationLanguage: "en" });
          yield* f.tick;
          expect(f.notify.mock.calls[0]?.[1]).toContain(phrase);
          expect(f.notify.mock.calls[0]?.[1]).toContain(email);
        }),
      ),
    ),
);

test.each(["sent", "pending", "failed"] as const)(
  "a %s transport outcome never causes another send or changes Selection eligibility",
  (state) =>
    withContactDatabase(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* notificationFixture;
          f.notificationStatus.mockReturnValue(
            Effect.succeed({ state, error: state === "failed" ? 22 : 0, dateRead: null }),
          );
          yield* submitAndRestart(f);
          expect(yield* f.snapshot).toMatchObject({
            entries: [
              {
                notification: state === "pending" ? "uncertain" : state,
                eligible: true,
                reason: "ready",
              },
            ],
          });
          if (state === "failed") {
            expect(f.logs).toContainEqual(
              expect.objectContaining({
                stage: "transport.status",
                operationId: "mac-request",
                code: "IMSG_SEND_22",
                level: "error",
              }),
            );
            expect(f.logs.at(-1)?.outcome).toBe("failed");
          }
        }),
      ),
    ),
);

test.each(["send", "status", "commit"])(
  "%s failure preserves uncertainty and redacted correlated diagnostics across restart",
  (stage) =>
    withContactDatabase(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* notificationFixture;
          const cause = Object.assign(
            new Error("private +821012345678 Bearer secret-token private-message"),
            { code: "ECONNRESET" },
          );
          if (stage === "send") f.notify.mockReturnValue(Effect.fail(cause));
          if (stage === "status") f.notificationStatus.mockReturnValue(Effect.fail(cause));
          if (stage === "commit")
            yield* f.sql`CREATE TRIGGER fail_notification_commit BEFORE UPDATE OF guid ON discovery_notification BEGIN SELECT RAISE(ABORT, 'private payload'); END`;
          yield* submitAndRestart(f);
          expect(yield* f.snapshot).toMatchObject({
            entries: [{ notification: "uncertain", eligible: true }],
          });
          const failure = f.logs.find((event) => event.level === "error")!;
          expect(failure.requestId).toEqual(expect.any(String));
          expect(failure.causeName).toEqual(expect.any(String));
          expect(failure).toMatchObject({
            stage: stage === "commit" ? "notification.commit" : `transport.${stage}`,
            outcome: "failed",
          });
          if (stage !== "commit") expect(failure.causeCode).toBe("ECONNRESET");
          expect(f.logs.at(-1)).toMatchObject({
            requestId: failure.requestId,
            stage: "complete",
            outcome: "failed",
          });
          const logged = JSON.stringify(f.logs);
          for (const privateValue of [
            "+821012345678",
            "secret-token",
            "private-message",
            "private payload",
          ])
            expect(logged).not.toContain(privateValue);
        }),
      ),
    ),
);

test("an atomic registration failure cannot leave a Notification or Likes behind, and stale consent is rejected", () =>
  withContactDatabase(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* notificationFixture;
        expect((yield* f.join({ privacyNoticeVersion: "discovery-2026-10-17" })).status).toBe(400);
        yield* f.sql`CREATE TRIGGER fail_notification_insert BEFORE INSERT ON discovery_notification BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END`;
        expect((yield* f.join()).status).toBe(400);
        for (const rows of [
          yield* f.sql`SELECT * FROM discovery_registration`,
          yield* f.sql`SELECT * FROM discovery_like`,
          yield* f.sql`SELECT * FROM discovery_notification`,
        ])
          expect(rows).toEqual([]);
        yield* f.tick;
        expect(f.notify).not.toHaveBeenCalled();
      }),
    ),
  ));

test("a queued entry removed during another send is not submitted; old registrations are not backfilled", () =>
  withContactDatabase(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* notificationFixture;
        yield* f.register("+821011110000");
        yield* f.join({ handle: "+821011110000" });
        yield* f.join();
        yield* f.join({ handle: "+821099990000" });
        f.notify.mockImplementation(() =>
          Effect.gen(function* () {
            yield* f.sql`DELETE FROM discovery_registration`;
            return { guid: "guid", requestId: "mac-request" };
          }),
        );
        yield* f.tick;
        expect(f.notify).toHaveBeenCalledTimes(1);
        expect(yield* f.sql`SELECT * FROM discovery_notification`).toEqual([]);
        expect(yield* f.sql`SELECT COUNT(*) AS count FROM notification_attempt`).toEqual([
          { count: 1 },
        ]);
      }),
    ),
  ));
