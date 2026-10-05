import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { timing } from "./timing.ts";

test("wait caps each call at 55 minutes, can repeat, and wakes only for its Conversation", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const pace = timing();
        const full = yield* Effect.forkScoped(pace.wait("first", 5));
        yield* TestClock.adjust("4 seconds");
        expect(full.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("1 second");
        expect(yield* Fiber.join(full)).toBe("paused 5s");

        const capped = yield* Effect.forkScoped(pace.wait("first", 60_000));
        yield* TestClock.adjust("54 minutes");
        expect(capped.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("1 minute");
        expect(capped.pollUnsafe()).toBeDefined();
        expect(yield* Fiber.join(capped)).toBe("paused 3300s");

        const repeated = yield* Effect.forkScoped(pace.wait("first", 3300));
        yield* TestClock.adjust("54 minutes");
        expect(repeated.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("1 minute");
        expect(yield* Fiber.join(repeated)).toBe("paused 3300s");

        const early = yield* Effect.forkScoped(pace.wait("first", 60));
        yield* TestClock.adjust("20 seconds");
        pace.onNew("other");
        expect(early.pollUnsafe()).toBeUndefined();
        pace.onNew("first");
        expect(yield* Fiber.join(early)).toBe("paused 20s, cut short by something new");
        const one = yield* Effect.forkScoped(pace.wait("first", 60));
        const two = yield* Effect.forkScoped(pace.wait("first", 60));
        yield* TestClock.adjust("10 seconds");
        pace.onNew("first");
        expect(yield* Fiber.join(one)).toBe("paused 10s, cut short by something new");
        expect(yield* Fiber.join(two)).toBe("paused 10s, cut short by something new");
        // A notification during the action, even before its listener starts, also wins.
        expect(
          yield* pace.during(
            "first",
            Effect.sync(() => {
              pace.onNew("first");
              return true;
            }),
          ),
        ).toBe("new");
        expect(
          yield* pace.during(
            "first",
            Effect.sync(() => pace.onNew("first")).pipe(Effect.andThen(Effect.never)),
          ),
        ).toBe("new");
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );
});
