import { Deferred, Effect, Fiber } from "effect";
import { expect, test } from "vitest";
import { fakeMessages } from "@ren-ai/imsg/testing";
import { intake } from "./intake.ts";
import { migrate } from "../database.ts";
import { registration, runMessagingTest } from "../../test/messaging.test-helper.ts";
import { conversations } from "../conversations/conversations.ts";
import { TestClock } from "effect/testing";

test("idle intake reads only the bookmark and new rows, even with a large history", async () => {
  await runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const fake = fakeMessages();
      const rows = Array.from({ length: 100_000 }, (_, i) => ({
        id: i + 1,
        guid: `history-${i}`,
        handle: "unregistered@example.com",
        createdAt: i + 1,
        text: "historical",
        fromMe: false,
      }));
      yield* fake.replace(rows);
      let returned = 0;
      const open = intake(
        {
          ...fake.messages,
          after: (id, limit) =>
            fake.messages.after(id, limit).pipe(
              Effect.tap((page) =>
                Effect.sync(() => {
                  returned += page.length;
                }),
              ),
            ),
        },
        () => Effect.succeed(undefined),
        () => Effect.void,
        () => "UTC",
      );
      const incoming = yield* open;
      returned = 0;
      yield* incoming.poll;
      expect(returned).toBe(1);
      returned = 0;
      yield* open;
      expect(returned).toBe(2);
      returned = 0;
      yield* fake.text("new@example.com", "new", 100_001);
      yield* incoming.poll;
      expect(returned).toBe(2);
      // A replacement must still recover when ROWIDs restart below the bookmark.
      yield* fake.replace([{ ...rows[0]!, createdAt: 100_002, guid: "replacement" }]);
      yield* incoming.poll;
      returned = 0;
      yield* incoming.poll;
      expect(returned).toBe(1);
    }),
  );
});

test("stalled admission backs off idle observations instead of polling every second", async () => {
  await runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const directory = yield* conversations;
      yield* directory.create(registration("slow@example.com", "slow"));
      const fake = fakeMessages();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let polls = 0;
      const incoming = yield* intake(
        {
          ...fake.messages,
          after: (id, limit) => {
            polls++;
            return fake.messages.after(id, limit);
          },
        },
        directory.byHandle,
        () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        () => "UTC",
      );
      yield* fake.text("slow@example.com", "pending", Date.now());
      polls = 0;
      const polling = yield* incoming.poll.pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("29 seconds");
      expect(polls).toBe(5);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(polling);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("a failed Conversation cannot pin the global bookmark ahead of other users, and queued rows survive restart", async () => {
  await runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const directory = yield* conversations;
      for (const name of ["blocked", "ready"])
        yield* directory.create(registration(`${name}@example.com`, `ses_${name}`));
      const fake = fakeMessages();
      let failing = true;
      const seen: string[] = [];
      const open = intake(
        fake.messages,
        directory.byHandle,
        (id, promptID) =>
          Effect.gen(function* () {
            if (id === "ses_blocked" && failing)
              yield* Effect.fail(new Error("temporarily unavailable"));
            seen.push(promptID);
          }),
        () => "UTC",
      );
      const first = yield* open;
      for (let i = 0; i < 100; i++) yield* fake.text("blocked@example.com", "queued", i + 1);
      yield* fake.text("ready@example.com", "ready", 101);
      yield* first.poll.pipe(Effect.result);
      yield* first.poll.pipe(Effect.result);
      expect(seen).toHaveLength(1);
      failing = false;
      yield* TestClock.adjust("31 seconds");
      const replacement = yield* open;
      for (let i = 0; i < 4; i++) yield* replacement.poll;
      expect(seen).toHaveLength(101);
      expect(new Set(seen).size).toBe(101);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("a slow Conversation does not hold other Conversations, while order and failed-prefix replay remain safe", async () => {
  await runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const directory = yield* conversations;
      for (const name of ["slow", "fast"])
        yield* directory.create(registration(`${name}@example.com`, `ses_${name}`));
      const fake = fakeMessages();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const seen: string[] = [];
      let fail = true;
      const incoming = yield* intake(
        fake.messages,
        directory.byHandle,
        (id, _prompt, text) =>
          Effect.gen(function* () {
            if (id === "ses_slow" && fail) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              yield* Effect.fail(new Error("retry admission"));
            }
            seen.push(text);
          }),
        () => "UTC",
      );
      yield* fake.text("slow@example.com", "slow first", Date.now());
      yield* fake.text("fast@example.com", "fast first", Date.now());
      yield* fake.text("fast@example.com", "fast second", Date.now());
      const task = yield* Effect.forkScoped(incoming.poll.pipe(Effect.result));
      yield* Deferred.await(entered);
      for (let i = 0; i < 100 && seen.length < 2; i++) yield* Effect.yieldNow;
      const progressed = seen.length;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(task);
      expect(progressed).toBe(2);
      expect(seen[0]).toContain("fast first");
      expect(seen[1]).toContain("fast second");
      fail = false;
      yield* TestClock.adjust("31 seconds");
      yield* incoming.poll;
      expect(seen).toHaveLength(3);
      expect(seen[2]).toContain("slow first");
      yield* incoming.poll;
      expect(seen).toHaveLength(3);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
