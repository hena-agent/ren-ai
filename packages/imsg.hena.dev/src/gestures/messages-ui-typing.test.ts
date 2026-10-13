import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { failure, setup } from "../../test/messages-ui.test-helper.ts";

const alice = "alice@example.com";

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
