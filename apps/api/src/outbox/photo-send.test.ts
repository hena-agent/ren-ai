import { Clock, Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";
import { expect, test, vi } from "vitest";
import { fakeGestures, fakeMessages } from "@ren-ai/imsg/testing";
import { registration, runMessagingTest } from "../../test/messaging.test-helper.ts";
import { conversations } from "../conversations/conversations.ts";
import { migrate } from "../database.ts";
import { timing } from "../timing/timing.ts";
import { outbox } from "./outbox.ts";
import { photo, takenPhoto } from "./photo.test-helper.ts";

const personas = new Map([["persona1", { timeZone: "UTC" }]]);
type LoadPhoto = () => Effect.Effect<string | undefined, Error>;
const fixture = Effect.gen(function* () {
  yield* migrate;
  const sql = yield* SqlClient.SqlClient;
  const directory = yield* conversations;
  const conversation = yield* directory.create(registration("photo@example.test", "photo"));
  const fake = fakeMessages();
  const ui = fakeGestures();
  const pace = yield* timing;
  const sends = yield* outbox(fake.messages, ui.gestures, personas, directory.active, pace);
  return { sql, directory, conversation, fake, ui, pace, sends };
});

test("photos wait for seen arrivals and four quiet seconds without typing, keeping cancelled photos", async () => {
  await runMessagingTest(
    Effect.gen(function* () {
      const { conversation, fake, ui, pace, sends, sql } = yield* fixture;
      yield* takenPhoto(conversation, "photo-id");
      const load = vi.fn<LoadPhoto>(() => Effect.succeed(photo));
      yield* pace.onNew(conversation.sessionID, "first");
      expect(yield* sends.sendPhoto(conversation, "photo-id", "unseen", load)).toContain(
        "Keep this photo",
      );
      expect(load).not.toHaveBeenCalled();
      yield* pace.seen(conversation.sessionID, ["first"]);
      const cancelled = yield* sends
        .sendPhoto(conversation, "photo-id", "quiet", load)
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust("3 seconds");
      expect(load).not.toHaveBeenCalled();
      yield* pace.onNew(conversation.sessionID, "second");
      expect(yield* Fiber.join(cancelled)).toContain("Keep this photo");
      expect(yield* sql`SELECT id FROM send`).toEqual([]);
      yield* pace.seen(conversation.sessionID, ["second"]);
      const completed = yield* sends
        .sendPhoto(conversation, "photo-id", "retry", load)
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust("3 seconds");
      expect(load).not.toHaveBeenCalled();
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(completed)).toBe("sent");
      expect(load).toHaveBeenCalledTimes(1);
      expect(ui.typing).toEqual([]);
      const [row] = yield* fake.messages.recent(conversation.handle, 0);
      expect(row?.attachments).toHaveLength(1);
      expect(yield* sql`SELECT kind, content, state, attempt_id, guid FROM send`).toEqual([
        {
          kind: "photo",
          content: "photo-id",
          state: "sent",
          attempt_id: row!.guid,
          guid: row!.guid,
        },
      ]);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("photo loading is inside the conversation lock, after pacing, and repeated calls never reload", async () => {
  await runMessagingTest(
    Effect.gen(function* () {
      const { conversation, fake, sends, sql } = yield* fixture;
      yield* takenPhoto(conversation, "one");
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const load = vi.fn<LoadPhoto>(() =>
        Effect.gen(function* () {
          expect(yield* sql`SELECT id FROM send`).toEqual([]);
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(finish);
          return photo;
        }),
      );
      const first = yield* sends
        .sendPhoto(conversation, "one", "first", load)
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const repeated = yield* sends
        .sendPhoto(conversation, "one", "first", load)
        .pipe(Effect.forkScoped);
      yield* Deferred.succeed(finish, undefined);
      expect(yield* Fiber.join(first)).toBe("sent");
      expect(yield* Fiber.join(repeated)).toContain("already recorded");
      expect(load).toHaveBeenCalledTimes(1);
      const once = () =>
        Effect.gen(function* () {
          const previous = yield* sql`SELECT id FROM send WHERE conversation_id = ${conversation.id}
          AND kind = 'photo' AND content = 'one' AND state != 'not_sent'`;
          return previous.length ? undefined : photo;
        });
      expect(yield* sends.sendPhoto(conversation, "one", "different-call", once)).toContain(
        "already attempted",
      );
      expect(yield* fake.messages.recent(conversation.handle, 0)).toHaveLength(1);
    }),
  );
});

test("expiry is checked after quiet and arrivals during image loading cancel before admission", async () => {
  await runMessagingTest(
    Effect.gen(function* () {
      const { conversation, sends, pace, sql } = yield* fixture;
      const expires = (yield* Clock.currentTimeMillis) + 3000;
      yield* takenPhoto(conversation, "expired", expires);
      yield* takenPhoto(conversation, "available");
      const load = () =>
        Effect.map(Clock.currentTimeMillis, (now) => (now < expires ? photo : undefined));
      yield* pace.onNew(conversation.sessionID, "arrival");
      yield* pace.seen(conversation.sessionID, ["arrival"]);
      const expired = yield* sends
        .sendPhoto(conversation, "expired", "expired-call", load)
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust("4 seconds");
      expect(yield* Fiber.join(expired)).toContain("expired");
      const entered = yield* Deferred.make<void>();
      const loading = yield* sends
        .sendPhoto(conversation, "available", "interrupted", () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* pace.onNew(conversation.sessionID, "new");
      expect(yield* Fiber.join(loading)).toContain("Keep this photo");
      expect(yield* sql`SELECT id FROM send`).toEqual([]);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("loader errors and inactive conversations do not admit a photo", async () => {
  await runMessagingTest(
    Effect.gen(function* () {
      const { conversation, sends, sql } = yield* fixture;
      yield* takenPhoto(conversation, "one");
      const failure = new Error("private image unavailable");
      expect(
        yield* sends
          .sendPhoto(conversation, "one", "failure", () => Effect.fail(failure))
          .pipe(Effect.flip),
      ).toBe(failure);
      yield* sql`UPDATE conversation SET rebuilding = 1 WHERE id = ${conversation.id}`;
      const load = vi.fn<LoadPhoto>(() => Effect.succeed(photo));
      expect(yield* sends.sendPhoto(conversation, "one", "inactive", load)).toContain(
        "unavailable",
      );
      expect(load).not.toHaveBeenCalled();
      yield* sql`UPDATE conversation SET rebuilding = 0 WHERE id = ${conversation.id}`;
      expect(
        yield* sends.sendPhoto(conversation, "one", "raced", () =>
          sql`UPDATE conversation SET rebuilding = 1 WHERE id = ${conversation.id}`.pipe(
            Effect.as(photo),
          ),
        ),
      ).toContain("unavailable");
      expect(yield* sql`SELECT id FROM send`).toEqual([]);
    }),
  );
});

test("a relationship introduction precedes a photo and its cancellation preserves the photo", async () => {
  await runMessagingTest(
    Effect.gen(function* () {
      const { conversation: old, fake, ui, sql } = yield* fixture;
      yield* sql`UPDATE conversation SET ended_at = 1 WHERE id = ${old.id}`;
      const [created] = yield* sql<{
        id: number;
      }>`INSERT INTO conversation (user_id, persona_id, session_id, started_at)
        SELECT user_id, 'persona2', 'next', 2 FROM conversation WHERE id = ${old.id} RETURNING id`;
      const conversation = { ...old, id: created!.id, sessionID: "next", personaID: "persona2" };
      yield* takenPhoto(conversation, "first-photo");
      const sends = yield* outbox(
        fake.messages,
        ui.gestures,
        new Map([["persona2", { timeZone: "UTC" }]]),
      );
      const load = vi.fn<LoadPhoto>(() => Effect.succeed(photo));
      ui.interrupt();
      expect(yield* sends.sendPhoto(conversation, "first-photo", "cancelled", load)).toContain(
        "Keep this photo",
      );
      expect(load).not.toHaveBeenCalled();
      const readyUI = fakeGestures();
      const ready = yield* outbox(fake.messages, readyUI.gestures, personas);
      expect(yield* ready.sendPhoto(conversation, "first-photo", "sent", load)).toBe("sent");
      expect(yield* sql`SELECT kind, tool_call_id FROM send ORDER BY id`).toEqual([
        { kind: "text", tool_call_id: "relationship-introduction" },
        { kind: "photo", tool_call_id: "sent" },
      ]);
      expect(fake.bubbles[0]?.text).toContain("[Ren AI]");
      expect(ui.typing).toHaveLength(1);
      expect(readyUI.typing).toHaveLength(1);
      expect(yield* fake.messages.recent(conversation.handle, 0)).toHaveLength(2);
    }),
  );
});

test("photo reconciliation matches only the identified GUID, never photo IDs or empty text", async () => {
  await runMessagingTest(
    Effect.gen(function* () {
      const { conversation, fake, sends, sql } = yield* fixture;
      yield* takenPhoto(conversation, "photo-id");
      yield* takenPhoto(conversation, "next");
      yield* sql`INSERT INTO send(handle, conversation_id, kind, content, tool_call_id, state, recorded_at, updated_at)
        VALUES (${conversation.handle}, ${conversation.id}, 'photo', '', 'empty', 'uncertain', 0, 0)`;
      expect(
        yield* sends.reconcile(conversation, yield* fake.outgoing(conversation.handle, "", 10)),
      ).toBe(false);
      yield* sql`UPDATE send SET content = 'photo-id', attempt_id = 'PHOTO-GUID', guid = 'PHOTO-GUID'`;
      expect(
        yield* sends.reconcile(
          conversation,
          yield* fake.outgoing(conversation.handle, "photo-id", 11),
        ),
      ).toBe(false);
      const row = yield* fake.outgoing(conversation.handle, "", 12, "delivered", "PHOTO-GUID");
      expect(yield* sends.reconcile(conversation, row)).toBe(true);
      expect((yield* sends.results(conversation.sessionID))[0]).toMatchObject({
        kind: "photo",
        state: "delivered",
      });
      const load = vi.fn<LoadPhoto>(() => Effect.succeed(photo));
      expect(yield* sends.sendPhoto(conversation, "next", "next-call", load)).toContain(
        'earlier photo "photo-id" did go out',
      );
      expect(load).not.toHaveBeenCalled();
      expect(yield* sends.sendPhoto(conversation, "next", "new-call", load)).toBe("sent");
    }),
  );
});

test("an old Mac photo rejection resolves as failed without a fallback or blind retry", async () => {
  await runMessagingTest(
    Effect.gen(function* () {
      const { conversation, fake, ui, sql } = yield* fixture;
      yield* takenPhoto(conversation, "unsupported");
      const submit = vi.fn<() => Effect.Effect<never, Error>>(() =>
        Effect.fail(new Error("Photo send RPC unavailable")),
      );
      const old = yield* outbox({ ...fake.messages, sendPhoto: submit }, ui.gestures, personas);
      expect(
        yield* old.sendPhoto(conversation, "unsupported", "old-mac", () => Effect.succeed(photo)),
      ).toBe("not sent: send in doubt");
      expect(fake.bubbles).toEqual([]);
      const restarted = yield* outbox(fake.messages, ui.gestures, personas);
      yield* restarted.observe(conversation);
      expect(yield* restarted.delivery(conversation, "old-mac")).toBe("failed");
      expect(
        yield* restarted.sendPhoto(conversation, "unsupported", "old-mac", () =>
          Effect.die("must not reload"),
        ),
      ).toContain("already recorded");
      expect(submit).toHaveBeenCalledTimes(1);
      const [row] = yield* sql<{ id: string }>`SELECT attempt_id AS id FROM send`;
      yield* fake.messages.sendPhoto(conversation.handle, photo, row!.id);
      expect(yield* fake.messages.recent(conversation.handle, 0)).toEqual([]);
      expect(yield* restarted.send(conversation, "text continues", "next")).toBe("sent");
    }),
  );
});

test("photo admission checks expiry again after the loader and pacing have returned", async () => {
  await runMessagingTest(
    Effect.gen(function* () {
      const { conversation, fake, ui, directory, pace, sql } = yield* fixture;
      const expires = (yield* Clock.currentTimeMillis) + 1;
      yield* takenPhoto(conversation, "boundary", expires);
      const load = vi.fn<LoadPhoto>(() =>
        Effect.gen(function* () {
          expect(yield* Clock.currentTimeMillis).toBeLessThan(expires);
          return photo;
        }),
      );
      const sends = yield* outbox(fake.messages, ui.gestures, personas, directory.active, {
        ...pace,
        during: (sessionID, action) =>
          pace.during(sessionID, action).pipe(Effect.tap(() => TestClock.adjust("1 millis"))),
      });
      expect(
        yield* sends.sendPhoto(conversation, "boundary", "expired-at-admission", load),
      ).toContain("unavailable");
      expect(load).toHaveBeenCalledTimes(1);
      expect(yield* Clock.currentTimeMillis).toBe(expires);
      expect(yield* sql`SELECT id FROM send`).toEqual([]);
      expect(yield* fake.messages.recent(conversation.handle, 0)).toEqual([]);
      expect(yield* sql`SELECT state FROM conversation_photo WHERE id = 'boundary'`).toEqual([
        { state: "taken" },
      ]);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("atomic photo admission requires an owned taken receipt and ignores unadmitted sends", async () => {
  await runMessagingTest(
    Effect.gen(function* () {
      const { conversation, directory, sends, fake, sql } = yield* fixture;
      const other = yield* directory.create(registration("other@example.test", "other"));
      yield* takenPhoto(other, "foreign");
      yield* takenPhoto(conversation, "pending");
      yield* sql`UPDATE conversation_photo SET state = 'pending' WHERE id = 'pending'`;
      for (const id of ["missing", "foreign", "pending"])
        expect(yield* sends.sendPhoto(conversation, id, id, () => Effect.succeed(photo))).toContain(
          "unavailable",
        );
      expect(yield* sql`SELECT id FROM send`).toEqual([]);
      yield* takenPhoto(conversation, "unadmitted");
      yield* sql`INSERT INTO send(handle, conversation_id, kind, content, tool_call_id, state, recorded_at, updated_at)
        VALUES (${conversation.handle}, ${conversation.id}, 'photo', 'unadmitted', 'stopped', 'not_sent', 0, 0)`;
      expect(
        yield* sends.sendPhoto(conversation, "unadmitted", "new", () => Effect.succeed(photo)),
      ).toBe("sent");
      expect(yield* fake.messages.recent(conversation.handle, 0)).toHaveLength(1);
    }),
  );
});

test("independent Outbox instances cannot admit the same photo after both loaders validate it", async () => {
  await runMessagingTest(
    Effect.gen(function* () {
      const { conversation, sends, fake, ui, directory, sql } = yield* fixture;
      yield* takenPhoto(conversation, "shared");
      const other = yield* outbox(fake.messages, ui.gestures, personas, directory.active);
      const bothLoaded = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let loads = 0;
      const load = () =>
        Effect.gen(function* () {
          expect(yield* sql`SELECT id FROM send`).toEqual([]);
          loads++;
          if (loads === 2) yield* Deferred.succeed(bothLoaded, undefined);
          yield* Deferred.await(release);
          return photo;
        });
      const first = yield* sends
        .sendPhoto(conversation, "shared", "first", load)
        .pipe(Effect.forkScoped);
      const second = yield* other
        .sendPhoto(conversation, "shared", "second", load)
        .pipe(Effect.forkScoped);
      yield* Deferred.await(bothLoaded);
      yield* Deferred.succeed(release, undefined);
      const results = [yield* Fiber.join(first), yield* Fiber.join(second)];
      expect(results.filter((result) => result === "sent")).toHaveLength(1);
      expect(results.filter((result) => result.includes("unavailable"))).toHaveLength(1);
      expect(yield* sql`SELECT kind, content FROM send`).toEqual([
        { kind: "photo", content: "shared" },
      ]);
      expect(yield* fake.messages.recent(conversation.handle, 0)).toHaveLength(1);
      yield* sql`UPDATE send SET state = 'failed'`;
      expect(
        yield* other.sendPhoto(conversation, "shared", "after-failure", () =>
          Effect.succeed(photo),
        ),
      ).toContain("unavailable");
      expect(yield* sql`SELECT id FROM send`).toHaveLength(1);
    }),
  );
});
