import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { timing } from "./timing.ts";

test("wait lasts 60 minutes, caps at 12 hours, and wakes only for its Conversation", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const pace = timing();
        const full = yield* Effect.forkScoped(pace.wait(1, 60));
        yield* TestClock.adjust("59 minutes");
        expect(full.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("1 minute");
        expect(yield* Fiber.join(full)).toBe("paused 60m");

        const capped = yield* Effect.forkScoped(pace.wait(1, 1000));
        yield* TestClock.adjust("12 hours");
        expect(yield* Fiber.join(capped)).toBe("paused 720m");

        const early = yield* Effect.forkScoped(pace.wait(1, 60));
        yield* TestClock.adjust("20 seconds");
        pace.onNew(2);
        expect(early.pollUnsafe()).toBeUndefined();
        pace.onNew(1);
        expect(yield* Fiber.join(early)).toBe("paused 20s, cut short by something new");
        const one = yield* Effect.forkScoped(pace.wait(1, 60));
        const two = yield* Effect.forkScoped(pace.wait(1, 60));
        yield* TestClock.adjust("10 seconds");
        pace.onNew(1);
        expect(yield* Fiber.join(one)).toBe("paused 10s, cut short by something new");
        expect(yield* Fiber.join(two)).toBe("paused 10s, cut short by something new");
        // A notification during the action, even before its listener starts, also wins.
        expect(
          yield* pace.during(
            1,
            Effect.sync(() => {
              pace.onNew(1);
              return true;
            }),
          ),
        ).toBe("new");
        expect(
          yield* pace.during(
            1,
            Effect.sync(() => pace.onNew(1)).pipe(Effect.andThen(Effect.never)),
          ),
        ).toBe("new");
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );
});
