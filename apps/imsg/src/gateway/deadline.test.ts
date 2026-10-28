import { Cause, Deferred, Effect, Exit } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { gatewayFixture } from "../../test/gateway.test-helper.ts";

test.each(["read", "send"])(
  "a stalled messaging %s times out without retrying and releases its HTTP request",
  async (operation) => {
    const f = gatewayFixture();
    const entered = Deferred.makeUnsafe<void>();
    const signals: AbortSignal[] = [];
    f.local.messages.after = () =>
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
    f.local.messages.sendText = () =>
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
    const forward = f.transport.fetch;
    f.transport.fetch = (request) => {
      signals.push(request.signal);
      return forward(request);
    };
    try {
      await f.run((remote) =>
        Effect.gen(function* () {
          const call = yield* (
            operation === "read"
              ? remote.after(0)
              : remote.sendText("private@example.test", "private text", crypto.randomUUID())
          ).pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          yield* TestClock.adjust("29 seconds");
          expect(call.pollUnsafe()).toBeUndefined();
          yield* TestClock.adjust("1 second");
          const result = call.pollUnsafe();
          expect(result).toBeDefined();
          const failure =
            result && Exit.isFailure(result)
              ? result.cause.reasons.find(Cause.isFailReason)?.error
              : undefined;
          expect(failure).toBeInstanceOf(Error);
          expect(failure).toHaveProperty("cause._tag", "TimeoutError");
          expect(signals).toHaveLength(1);
          expect(signals[0]!.aborted).toBe(true);
          expect(f.local.bubbles).toEqual([]);
        }).pipe(Effect.provide(TestClock.layer())),
      );
    } finally {
      await f.server.dispose();
    }
  },
);

test("an idle messaging follow stream remains open beyond finite RPC deadlines", async () => {
  const f = gatewayFixture();
  const entered = Deferred.makeUnsafe<Request>();
  const forward = f.transport.fetch;
  f.transport.fetch = (request) => {
    Effect.runSync(Deferred.succeed(entered, request));
    return forward(request);
  };
  try {
    await f.run((remote) =>
      Effect.gen(function* () {
        const stop = yield* remote.follow(0, () => Effect.void);
        const request = yield* Deferred.await(entered);
        yield* TestClock.adjust("2 minutes");
        expect(request.signal.aborted).toBe(false);
        stop();
      }).pipe(Effect.provide(TestClock.layer())),
    );
    const request = Effect.runSync(Deferred.await(entered));
    expect(request.signal.aborted).toBe(true);
  } finally {
    await f.server.dispose();
  }
});
