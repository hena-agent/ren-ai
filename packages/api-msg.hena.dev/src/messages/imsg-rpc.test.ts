import { Effect, Fiber, Option, Queue, Result } from "effect";
import { expect, test } from "vitest";
import { fixture } from "./imsg.fake.ts";
import { imsgRpc } from "./imsg-rpc.ts";

test("RPC uses one child, correlates out-of-order replies, and frames requests exactly", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const rpc = yield* imsgRpc;
        f.hang("message.send_status");
        const first = yield* Effect.forkChild(rpc.request("message.send_status", { guid: "one" }));
        const second = yield* Effect.forkChild(rpc.request("message.send_status", { guid: "two" }));
        for (let i = 0; i < 100 && f.commands.length < 2; i++) yield* Effect.yieldNow;
        expect(f.inputLines).toEqual([
          `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message.send_status", params: { guid: "one" } })}\n`,
          `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "message.send_status", params: { guid: "two" } })}\n`,
        ]);
        f.connections[0]!.respond({ id: 2, result: { second: true } });
        f.connections[0]!.respond({ id: 1, result: { first: true } });
        expect(yield* Fiber.join(second)).toEqual({ second: true });
        expect(yield* Fiber.join(first)).toEqual({ first: true });
        f.connections[0]!.respond({ id: 999, result: { unsolicited: true } });
        yield* Effect.yieldNow;
        f.hang("");
        expect(yield* rpc.request("send", { to: "<iphone>" })).toMatchObject({ ok: true });
        expect(f.connections).toHaveLength(1);
      }).pipe(Effect.provide(f.dependencies)),
    ),
  );
});

test("RPC error details, pending disconnect, restart cleanup and stale notices", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const rpc = yield* imsgRpc;
        f.fail();
        const error = yield* rpc.request("send", { to: "<iphone>" }).pipe(Effect.flip);
        expect(error.message).toBe("imsg -32001: uncertain");
        f.hang("message.send_status");
        const pending = yield* Effect.forkChild(
          rpc.request("message.send_status", { guid: "pending" }).pipe(Effect.result),
        );
        for (let i = 0; i < 100 && f.commands.length < 2; i++) yield* Effect.yieldNow;
        f.connections[0]!.notify("message", { subscription: 1, message: {} });
        for (let i = 0; i < 100 && (yield* Queue.size(rpc.notices)) === 0; i++)
          yield* Effect.yieldNow;
        yield* rpc.restart;
        const outcome = yield* Fiber.join(pending);
        expect(Result.isFailure(outcome) && outcome.failure.message).toBe("imsg RPC disconnected");
        expect(Option.isNone(yield* Queue.poll(rpc.notices))).toBe(true);
        expect(f.connections[0]!.running()).toBe(false);
        f.hang("");
        f.succeed();
        expect(yield* rpc.request("send", { to: "<iphone>" })).toMatchObject({ ok: true });
        expect(f.connections).toHaveLength(2);
      }).pipe(Effect.provide(f.dependencies)),
    ),
  );
});

test("RPC bounds in-flight requests and releases their slots after every response", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const rpc = yield* imsgRpc;
        for (let i = 0; i < 130; i++) yield* rpc.request("send", { to: "<iphone>" });
        expect(f.commands).toHaveLength(130);
        f.hang("send");
        const pending = yield* Effect.forEach(Array.from({ length: 128 }), () =>
          Effect.forkChild(rpc.request("send", { to: "<iphone>" }).pipe(Effect.result)),
        );
        for (let i = 0; i < 100 && f.commands.length < 258; i++) yield* Effect.yieldNow;
        expect(f.commands).toHaveLength(258);
        expect((yield* rpc.request("send", { to: "<iphone>" }).pipe(Effect.flip)).message).toBe(
          "imsg RPC capacity exceeded",
        );
        yield* rpc.restart;
        const outcome = yield* Fiber.join(pending[0]!);
        expect(Result.isFailure(outcome) && outcome.failure.message).toBe("imsg RPC disconnected");
      }).pipe(Effect.provide(f.dependencies)),
    ),
  );
});

test.each(["exit", "invalid frame"] as const)(
  "RPC %s wakes watchers with a typed disconnect",
  async (cause) => {
    const f = fixture();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const rpc = yield* imsgRpc;
          yield* rpc.request("watch.subscribe", { since_rowid: -1 });
          expect(f.connections[0]!.finalized()).toBe(false);
          if (cause === "exit") f.connections[0]!.close();
          else f.connections[0]!.respond({ jsonrpc: "1.0", id: 999, result: {} });
          expect(yield* Queue.take(rpc.notices)).toEqual({
            method: "watch.disconnected",
            params: {},
          });
          for (let i = 0; i < 100 && !f.connections[0]!.finalized(); i++) yield* Effect.yieldNow;
          expect(f.connections[0]!.finalized()).toBe(true);
        }).pipe(Effect.provide(f.dependencies)),
      ),
    );
  },
);
