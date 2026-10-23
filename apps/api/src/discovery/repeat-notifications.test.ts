import { Effect } from "effect";
import { expect, test } from "vitest";
import { withContactDatabase } from "./contact.test-helper.ts";
import { notificationFixture } from "./notifications.test-helper.ts";

test.each([true, false])(
  "an active user gets a notification, with existing registration=%s",
  (registered) =>
    withContactDatabase(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* notificationFixture;
          if (registered) yield* f.register("+821012345678");
          yield* f.sql`INSERT INTO user (handle, locale, consent_version, consent_language, consent_at, joined_at)
      VALUES ('+821012345678', 'ko', 'old', 'ko', 1, 2)`;
          for (const locale of ["en", "ko", "ja"] as const) {
            const response = yield* f.join({ locale });
            expect(response.status).toBe(200);
            expect(yield* Effect.promise(() => response.json())).toEqual({ status: "active" });
            const requestId = response.headers.get("X-Request-ID");
            expect(
              yield* f.sql`SELECT request_id FROM discovery_notification WHERE locale = ${locale}`,
            ).toEqual([{ request_id: requestId }]);
          }
          yield* (yield* f.reopen()).tick;
          expect(f.notify).toHaveBeenCalledTimes(3);
          expect(f.notify.mock.calls.map((call) => call[1])).toEqual([
            expect.stringContaining("already registered"),
            expect.stringContaining("이미 등록된 번호"),
            expect.stringContaining("すでに登録されています"),
          ]);
          expect(yield* f.sql`SELECT id FROM conversation`).toEqual([]);
          expect(yield* f.sql`SELECT id FROM discovery_registration`).toHaveLength(
            registered ? 1 : 0,
          );
          yield* (yield* f.reopen()).tick;
          expect(f.notify).toHaveBeenCalledTimes(3);
        }),
      ),
    ),
);

test("a repeat keeps the earlier uncertain attempt and uses the new submission's language", () =>
  withContactDatabase(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* notificationFixture;
        f.notify.mockReturnValueOnce(
          Effect.succeed({ guid: "original-guid", requestId: "original-request" }),
        );
        f.notificationStatus.mockReturnValueOnce(
          Effect.succeed({ state: "pending", error: 0, dateRead: null }),
        );
        yield* f.join();
        yield* f.tick;
        yield* f.join({ locale: "ja" });
        expect(yield* f.snapshot).toMatchObject({ entries: [{ notification: "queued" }] });
        yield* (yield* f.reopen()).tick;
        expect(f.notify).toHaveBeenCalledTimes(2);
        expect(f.notify.mock.calls[1]?.[1]).toContain("この番号でRen AI");
        expect(yield* f.sql`SELECT state, guid FROM discovery_notification ORDER BY id`).toEqual([
          { state: "uncertain", guid: "original-guid" },
          { state: "sent", guid: "notification-guid" },
        ]);
        expect(yield* f.snapshot).toMatchObject({ entries: [{ notification: "sent" }] });
      }),
    ),
  ));

test("repeat submissions share the cap and deleting an active user cancels their queued notifications", () =>
  withContactDatabase(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* notificationFixture;
        yield* f.exhaustBudget;
        yield* f.join();
        yield* f.join();
        yield* f.tick;
        expect(f.notify).not.toHaveBeenCalled();
        expect(yield* f.sql`SELECT state FROM discovery_notification`).toEqual([
          { state: "skipped" },
          { state: "skipped" },
        ]);
        yield* f.sql`INSERT INTO user (handle, locale, consent_version, consent_language, consent_at, joined_at)
      VALUES ('+821099990000', 'en', 'old', 'en', 1, 2)`;
        yield* f.join({ handle: "+821099990000" });
        yield* f.sql`DELETE FROM user`;
        expect(yield* f.sql`SELECT id FROM discovery_notification WHERE state = 'queued'`).toEqual(
          [],
        );
        yield* f.tick;
        expect(f.notify).not.toHaveBeenCalled();
      }),
    ),
  ));
