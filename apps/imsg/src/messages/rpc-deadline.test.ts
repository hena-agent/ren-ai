import { Effect, Fiber, Logger, Result } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { imsgRpc } from "./imsg-rpc.ts";
import { fixture } from "./imsg.fake.ts";

test("a live but unresponsive child times out, releases capacity and reconnects without resending", async () => {
  const f = fixture();
  const events: string[] = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const rpc = yield* imsgRpc;
        f.hang("send");
        const pending = yield* Effect.forkScoped(
          rpc.request("send", { to: "private", text: "secret" }).pipe(Effect.flip),
        );
        yield* TestClock.adjust("31 seconds");
        expect(pending.pollUnsafe()).toBeDefined();
        expect((yield* Fiber.join(pending)).message).toContain("timed out");
        f.hang("");
        expect(yield* rpc.request("message.send_status", { guid: "uncertain" })).toBeDefined();
        expect(f.connections).toHaveLength(2);
        expect(f.connections[0]!.finalized()).toBe(true);
        expect(f.commands.filter((c) => c.method === "send")).toHaveLength(1);
      }).pipe(
        Effect.provide(f.dependencies),
        Effect.provide(TestClock.layer()),
        Effect.provide(
          Logger.layer([
            Logger.make((entry) => {
              events.push(JSON.stringify(entry.message));
            }),
          ]),
        ),
      ),
    ),
  );
  const failures = events.filter((event) => event.includes('"outcome":"failed"'));
  expect(failures).toHaveLength(1);
  expect(failures[0]).toContain('"code":"IMSG_RPC_TIMEOUT"');
  expect(failures[0]).toContain('"stage":"imsg.rpc.send"');
  expect(failures[0]).toMatch(/"requestId":"[0-9a-f-]{36}"/);
  expect(events.join()).not.toContain("secret");
  expect(events.join()).not.toContain("private");
});

test("simultaneous expired requests share one child recovery and do not replay mutations", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const rpc = yield* imsgRpc;
        f.hang("send");
        const requests = yield* Effect.forEach(Array.from({ length: 128 }), () =>
          Effect.forkScoped(rpc.request("send", { text: "private" }).pipe(Effect.result)),
        );
        yield* TestClock.adjust("31 seconds");
        for (const task of requests) expect(Result.isFailure(yield* Fiber.join(task))).toBe(true);
        f.hang("");
        yield* rpc.request("status", {});
        expect(f.connections).toHaveLength(2);
        expect(f.commands.filter((row) => row.method === "send")).toHaveLength(128);
      }).pipe(Effect.provide(f.dependencies), Effect.provide(TestClock.layer())),
    ),
  );
});
