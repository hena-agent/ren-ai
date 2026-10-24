import { Clock, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { HttpClientError } from "effect/unstable/http";
import { RpcClientError } from "effect/unstable/rpc";
import { afterEach, expect, test, vi } from "vitest";
import { resilientContext } from "./context.ts";

afterEach(() => vi.restoreAllMocks());

const capture = () => ({
  errors: vi.spyOn(process.stderr, "write").mockReturnValue(true),
  summaries: vi.spyOn(process.stdout, "write").mockReturnValue(true),
});

const interruptContext = (error: RpcClientError.RpcClientError) =>
  Effect.gen(function* () {
    const running = yield* resilientContext(Effect.fail(error), "session").pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(running);
  });

test("context recovery backs off to 30 seconds, stays live across a long outage and logs once", async () => {
  const logs = capture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const attempts: number[] = [];
        let available = false;
        const request = Effect.gen(function* () {
          attempts.push(yield* Clock.currentTimeMillis);
          return available ? "fresh context" : yield* Effect.fail("private application failure");
        });
        const running = yield* resilientContext(request, "session").pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        for (const delay of [1, 2, 4, 8, 16, 30, 30]) {
          const before = attempts.length;
          yield* TestClock.adjust(delay * 1000 - 1);
          expect(attempts).toHaveLength(before);
          yield* TestClock.adjust(1);
          expect(attempts).toHaveLength(before + 1);
        }
        expect(running.pollUnsafe()).toBeUndefined();
        available = true;
        yield* TestClock.adjust("30 seconds");
        expect(yield* Fiber.join(running)).toBe("fresh context");
        expect(logs.errors).toHaveBeenCalledTimes(1);
        expect(logs.errors.mock.calls[0]?.[0]).toContain('"code":"ApplicationError"');
        expect(logs.summaries).toHaveBeenCalledTimes(1);
        expect(logs.summaries.mock.calls[0]?.[0]).toContain('"outcome":"succeeded"');
        expect(logs.summaries.mock.calls[0]?.[0]).toContain('"failures":8');
        expect(JSON.stringify(logs.errors.mock.calls)).not.toContain("private");
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );
});

test.each([503, undefined])(
  "HTTP context failures keep safe cause/status metadata (%s)",
  async (status) => {
    const logs = capture();
    const error = new RpcClientError.RpcClientError({
      reason: new HttpClientError.HttpClientErrorSchema({
        _tag: "HttpError",
        kind: "TransportError",
        cause: { response: { status }, authorization: "private token", text: "private text" },
      }),
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* interruptContext(error);
          yield* TestClock.adjust("1 minute");
          expect(logs.errors).toHaveBeenCalledTimes(1);
          expect(logs.errors.mock.calls[0]?.[0]).toContain('"causeCode":"TransportError"');
          if (status) expect(logs.errors.mock.calls[0]?.[0]).toContain('"upstreamStatus":503');
          else expect(logs.errors.mock.calls[0]?.[0]).not.toContain("upstreamStatus");
          expect(logs.summaries.mock.calls[0]?.[0]).toContain('"outcome":"interrupted"');
          expect(JSON.stringify(logs.errors.mock.calls)).not.toContain("private");
        }).pipe(Effect.provide(TestClock.layer())),
      ),
    );
  },
);

test("hung context requests time out and cancellation stops the next request", async () => {
  const logs = capture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        let attempts = 0;
        let cancelled = 0;
        const request = Effect.suspend(() => {
          attempts++;
          return Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                cancelled++;
              }),
            ),
          );
        });
        const running = yield* resilientContext(request, "session").pipe(Effect.forkScoped);
        yield* TestClock.adjust("10 seconds");
        expect(cancelled).toBe(1);
        expect(logs.errors.mock.calls[0]?.[0]).toContain('"code":"TimeoutError"');
        yield* TestClock.adjust("1 second");
        expect(attempts).toBe(2);
        yield* Fiber.interrupt(running);
        yield* TestClock.adjust("1 minute");
        expect(attempts).toBe(2);
        expect(cancelled).toBe(2);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );
});

test.each([undefined, 42, "private token", "ECONNRESET"])(
  "context diagnostics retain safe underlying codes and stack frames (%s)",
  async (code) => {
    const logs = capture();
    const root = new Error("private response payload");
    if (code !== undefined) Object.assign(root, { code });
    if (code === undefined) delete root.stack;
    else
      root.stack =
        "Error: private response payload\n    at request (client.ts:12:3)\nprivate authorization";
    const error = new RpcClientError.RpcClientError({
      reason: new HttpClientError.HttpClientErrorSchema({
        _tag: "HttpError",
        kind: "TransportError",
        cause: root,
      }),
    });
    await Effect.runPromise(Effect.scoped(interruptContext(error)));
    const diagnostic = String(logs.errors.mock.calls[0]?.[0]);
    expect(diagnostic).not.toContain("private");
    expect(diagnostic.includes('"underlyingCode":"ECONNRESET"')).toBe(code === "ECONNRESET");
    expect(diagnostic.includes("underlyingCode")).toBe(code === "ECONNRESET");
    expect(diagnostic).toContain(code === undefined ? '"stack":""' : "at request (client.ts:12:3)");
  },
);

test("healthy context requests finish without recovery diagnostics", async () => {
  const logs = capture();
  expect(await Effect.runPromise(resilientContext(Effect.succeed("fresh"), "session"))).toBe(
    "fresh",
  );
  expect(logs.errors).not.toHaveBeenCalled();
  expect(logs.summaries).not.toHaveBeenCalled();
});
