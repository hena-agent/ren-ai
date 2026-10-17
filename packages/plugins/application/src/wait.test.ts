import { Effect, Exit, Fiber, Queue, Scope, Stream } from "effect";
import { expect, test, vi } from "vitest";
import { localWait } from "./wait.ts";
import { TestClock } from "effect/testing";

test("local waits finish on their deadline or an admitted input for the same session", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<{ sessionID: string; messageID: string }>();
        const local = yield* localWait(Stream.fromQueue(events));
        expect(yield* local.wait("a", 0)).toBe("paused 0s");
        local.observed("a", ["already-seen"]);
        const waiting = yield* local.wait("a", 3300).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Queue.offer(events, { sessionID: "a", messageID: "already-seen" });
        yield* Queue.offer(events, { sessionID: "b", messageID: "other" });
        yield* Effect.yieldNow;
        expect(waiting.pollUnsafe()).toBeUndefined();
        yield* Queue.offer(events, { sessionID: "a", messageID: "new" });
        expect(yield* Fiber.join(waiting)).toContain("cut short by something new");
        expect(yield* local.wait("a", 3300)).toContain("cut short by something new");
        // Context assembled before the arrival must not acknowledge that arrival.
        local.observed("a", ["already-seen"]);
        expect(yield* local.wait("a", 3300)).toContain("cut short by something new");
        local.observed("a", ["already-seen", "new"]);
        const cancelled = yield* local.wait("a", 3300).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(cancelled);
        expect(yield* local.wait("a", 0)).toBe("paused 0s");
        yield* Queue.offer(events, { sessionID: "a", messageID: "second" });
        yield* Effect.yieldNow;
        expect(yield* local.wait("a", 3300)).toContain("cut short by something new");
      }),
    ),
  );
});

test("a subscription failure wakes pending waits with an error and subsequent arrivals restore waiting", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* Queue.unbounded<{ sessionID: string; messageID: string }, Error>();
          let first = true;
          const stream = Stream.suspend(() => {
            if (!first) return Stream.make({ sessionID: "a", messageID: "recovered" });
            first = false;
            return Stream.fromQueue(events);
          });
          const local = yield* localWait(stream);
          const waiting = yield* local.wait("a", 3300).pipe(Effect.forkScoped);
          yield* Effect.yieldNow;
          yield* Queue.fail(events, new Error("private subscription failure"));
          expect(Exit.isFailure(yield* Fiber.await(waiting))).toBe(true);
          expect(yield* local.wait("a", 1).pipe(Effect.flip)).toBeInstanceOf(Error);
          yield* TestClock.adjust("1 second");
          expect(yield* local.wait("a", 1)).toContain("cut short");
          expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).not.toContain(
            "private",
          );
        }).pipe(Effect.provide(TestClock.layer())),
      ),
    );
  } finally {
    stderr.mockRestore();
  }
});

test("disposing the plugin cancels an active tool wait and rejects later waits", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const lifetime = yield* Scope.make();
        const local = yield* localWait(Stream.never).pipe(
          Effect.provideService(Scope.Scope, lifetime),
        );
        const waiting = yield* local.wait("session", 3300).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Scope.close(lifetime, Exit.void);
        yield* Effect.yieldNow;
        expect(waiting.pollUnsafe()).toBeDefined();
        expect(Exit.isFailure(yield* Fiber.await(waiting))).toBe(true);
        expect(yield* local.wait("session", 1).pipe(Effect.flip)).toBeInstanceOf(Error);
      }),
    ),
  );
});
