import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { timing } from "./timing.ts";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { migrate } from "../database.ts";

test("wait caps each call at 55 minutes, can repeat, and wakes only for its Conversation", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* migrate;
        const pace = yield* timing;
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
        yield* pace.onNew("other", "message");
        expect(early.pollUnsafe()).toBeUndefined();
        yield* pace.onNew("first", "message");
        expect(yield* Fiber.join(early)).toBe("paused 20s, cut short by something new");
        yield* pace.seen("first", ["message"]);
        const one = yield* Effect.forkScoped(pace.wait("first", 60));
        const two = yield* Effect.forkScoped(pace.wait("first", 60));
        yield* TestClock.adjust("10 seconds");
        yield* pace.onNew("first", "second");
        expect(yield* Fiber.join(one)).toBe("paused 10s, cut short by something new");
        expect(yield* Fiber.join(two)).toBe("paused 10s, cut short by something new");
        yield* pace.seen("first", ["second"]);
        // A notification during the action, even before its listener starts, also wins.
        expect(
          yield* pace.during("first", pace.onNew("first", "third").pipe(Effect.as(true))),
        ).toBe("new");
        yield* pace.seen("first", ["third"]);
        expect(
          yield* pace.during(
            "first",
            pace.onNew("first", "fourth").pipe(Effect.andThen(Effect.never)),
          ),
        ).toBe("new");
      }).pipe(
        Effect.provide(TestClock.layer()),
        Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
  );
});

test("a restart preserves unseen arrivals and the remaining quiet window", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* migrate;
      const before = yield* timing;
      yield* before.onNew("first", "message");
      yield* TestClock.adjust("1 second");
      const after = yield* timing;
      expect(yield* after.during("first", Effect.succeed("stale reply"))).toBe("new");
      yield* after.seen("first", ["message"]);
      const ready = yield* Effect.forkScoped(after.during("first", after.quiet("first")));
      yield* TestClock.adjust("2 seconds");
      expect(ready.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(ready)).toBeUndefined();
      // Redelivery after restart must not revive an already acknowledged arrival.
      yield* after.onNew("first", "message");
      expect(yield* after.during("first", Effect.succeed(true))).toBe(true);
    }).pipe(
      Effect.scoped,
      Effect.provide(TestClock.layer()),
      Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
    ),
  );
});

test("an arrival during generation prevents a stale send or wait until the next context", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* migrate;
      const pace = yield* timing;
      yield* pace.onNew("first", "message");
      const action = Effect.die("stale action must not start");
      expect(yield* pace.during("first", action)).toBe("new");
      expect(yield* pace.wait("first", 600)).toBe("paused 0s, cut short by something new");
      expect(yield* pace.during("other", Effect.succeed(true))).toBe(true);
      yield* pace.seen("other", []);
      yield* pace.seen("first", ["previous"]);
      expect(yield* pace.during("first", action)).toBe("new");
      const context = [...Array.from({ length: 204 }, (_, i) => `message-${i}`), "message"];
      for (const id of context) yield* pace.onNew("first", id);
      yield* pace.onNew("other", "message");
      yield* pace.onNew("first", "outside-context");
      yield* pace.seen("first", context);
      expect(yield* pace.during("first", action)).toBe("new");
      yield* pace.seen("first", ["outside-context"]);
      expect(yield* pace.during("first", Effect.succeed(true))).toBe(true);
      yield* pace.seen("other", []);
      expect(yield* pace.during("other", action)).toBe("new");
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  );
});

test("typing waits for four quiet seconds since the latest arrival, including model thinking time", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* migrate;
      const pace = yield* timing;
      yield* pace.onNew("first", "message");
      yield* pace.seen("first", ["message"]);
      yield* TestClock.adjust("2 seconds");
      const waiting = yield* Effect.forkScoped(pace.during("first", pace.quiet("first")));
      yield* TestClock.adjust("1 second");
      expect(waiting.pollUnsafe()).toBeUndefined();
      yield* pace.onNew("first", "next");
      expect(yield* Fiber.join(waiting)).toBe("new");
      yield* pace.seen("first", ["next"]);
      const next = yield* Effect.forkScoped(pace.during("first", pace.quiet("first")));
      yield* TestClock.adjust("3 seconds");
      expect(next.pollUnsafe()).toBeUndefined();
      yield* pace.onNew("other", "message");
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(next)).toBeUndefined();
      // No arrival means no extra delay, even at the test clock's epoch.
      yield* pace.quiet("unused");
      yield* pace.seen("other", ["message"]);
      yield* TestClock.adjust("5 seconds");
      yield* pace.quiet("other");
    }).pipe(
      Effect.scoped,
      Effect.provide(TestClock.layer()),
      Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
    ),
  );
});
