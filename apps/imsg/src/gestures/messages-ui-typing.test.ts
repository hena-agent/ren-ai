import { Deferred, Effect, Fiber, Logger } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { failure, setup } from "../../test/messages-ui.test-helper.ts";

const alice = "alice@example.com";

test("a long typing uses a bounded number of native processes, not one process per character", async () => {
  const fixture = await setup();
  await Effect.runPromise(fixture.gestures.typing(alice, "x".repeat(1000), 0));
  expect(fixture.events.filter((event) => event.startsWith("key "))).toHaveLength(1);
  expect(fixture.events).toHaveLength(7);
});

test.each(["chats", "react"])("a stalled %s subprocess releases the shared UI", async (action) => {
  const fixture = await setup();
  fixture.blockAction(action, Effect.never);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const task = yield* Effect.forkScoped(
          fixture.gestures.react(alice, "love").pipe(Effect.result),
        );
        yield* TestClock.adjust("16 seconds");
        expect(task.pollUnsafe()).toBeDefined();
        fixture.blockAction("", Effect.void);
        yield* fixture.gestures.read(alice);
        expect(fixture.events.at(-1)).toBe("park");
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );
});

test("an overlong gesture cleans up its draft and emits private-data-free queue timings", async () => {
  const fixture = await setup();
  const logs: string[] = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const typing = yield* Effect.forkScoped(
          fixture.gestures.typing(alice, "private draft", 120_000).pipe(Effect.result),
        );
        yield* TestClock.adjust("61 seconds");
        expect(typing.pollUnsafe()).toBeDefined();
        expect(fixture.events.slice(-2)).toEqual([
          "clear sms://open?groupid=alice%40example.com",
          "park",
        ]);
        yield* fixture.gestures.probe();
      }).pipe(
        Effect.provide(TestClock.layer()),
        Effect.provide(
          Logger.layer([
            Logger.make((entry) => {
              logs.push(JSON.stringify(entry.message));
            }),
          ]),
        ),
      ),
    ),
  );
  expect(logs.join()).toContain('"queueWaitMs":0');
  expect(logs.join()).toContain('"outcome":"failed"');
  expect(logs.join()).not.toContain(alice);
  expect(logs.join()).not.toContain("private draft");
});

/** The persona's read holds the Messages UI until `release`, as when it calls read and send together. */
const readHoldingTheUi = async () => {
  const fixture = await setup();
  const holding = await Effect.runPromise(Deferred.make<void>());
  const release = await Effect.runPromise(Deferred.make<void>());
  fixture.blockAction(
    "read",
    Effect.andThen(Deferred.succeed(holding, undefined), Deferred.await(release)),
  );
  return { fixture, holding, release };
};

const flush = (done: () => boolean) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 1000 && !done(); turn++) yield* Effect.yieldNow;
  });

test("a typing cancelled while it waits for the UI never touches it and frees the queue", async () => {
  const { fixture, holding, release } = await readHoldingTheUi();
  const read = Effect.runFork(fixture.gestures.read(alice));
  await Effect.runPromise(Deferred.await(holding));
  const typing = Effect.runFork(fixture.gestures.typing(alice, "x", 0));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await Effect.runPromise(Fiber.interrupt(typing));
  await Effect.runPromise(Deferred.succeed(release, undefined));
  await Effect.runPromise(Fiber.join(read));
  fixture.blockAction("", Effect.void);
  await Effect.runPromise(fixture.gestures.read(alice));
  expect(fixture.events.filter((event) => /^(open|clear|key)/.test(event))).toEqual([]);
  expect(fixture.events.filter((event) => event === "ensure")).toHaveLength(2);
});

test("time spent waiting for the UI counts toward the typing time", async () => {
  const { fixture, holding, release } = await readHoldingTheUi();
  const outcome = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(100_000);
        yield* Effect.forkScoped(fixture.gestures.read(alice));
        yield* Deferred.await(holding);
        const typing = yield* Effect.forkScoped(fixture.gestures.typing(alice, "x", 1000));
        yield* TestClock.adjust(900);
        yield* Deferred.succeed(release, undefined);
        yield* flush(() => fixture.events.includes("key x"));
        yield* Effect.yieldNow;
        yield* TestClock.adjust(99);
        const pending = typing.pollUnsafe() === undefined;
        yield* TestClock.adjust(1);
        yield* flush(() => typing.pollUnsafe() !== undefined);
        return { pending, done: typing.pollUnsafe() !== undefined };
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );
  expect(outcome).toEqual({ pending: true, done: true });
});

test("a typing that cannot show alerts at once, and only a working typing clears the alert", async () => {
  const fixture = await setup();
  fixture.exitOn("key", "composer is not focused");
  await failure(fixture.gestures.typing(alice, "x", 0));
  fixture.exitOn("read", "chat unavailable");
  await failure(fixture.gestures.read(alice));
  fixture.exitOn("", "");
  await Effect.runPromise(fixture.gestures.read(alice));
  await Effect.runPromise(fixture.gestures.typing(alice, "x", 0));
  expect(fixture.alerts).toEqual([
    "typing: typing: Messages UI key: exit code 1: composer is not focused",
    "clear: gestures",
    "clear: messages-window",
    "clear: gestures",
    "clear: messages-window",
    "clear: typing",
  ]);
});
