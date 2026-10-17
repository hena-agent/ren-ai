import { Effect, Fiber, Logger } from "effect";
import { expect, test, vi } from "vitest";
import { BridgeUnavailable, startBridge } from "./bridge.ts";
import type { BridgeMessage } from "./bridge-protocol.ts";
import { bridgeFixture, incoming, service } from "../../test/bridge.test-helper.ts";

const options = {
  command: "ren-rustpush",
  args: ["rpc", service],
  env: { RUSTPUSH_STATE_DIR: "/state" },
};

type Call = Effect.Success<ReturnType<typeof startBridge>>["call"];

const ready = (call: Call) =>
  Effect.promise(() =>
    vi.waitFor(() => Effect.runPromise(call("handles", {})), { timeout: 2_000 }),
  );

const harness = (bridge = bridgeFixture(), healthyMillis?: number, requestMillis?: number) => {
  const alerts: string[] = [];
  const received: BridgeMessage[] = [];
  const logs: string[] = [];
  let failing = false;
  const run = <A, E>(story: (call: Call) => Effect.Effect<A, E>) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* startBridge(
            {
              ...options,
              restartMillis: 1,
              ...(healthyMillis === undefined ? {} : { healthyMillis }),
              ...(requestMillis === undefined ? {} : { requestMillis }),
            },
            (message) =>
              failing
                ? Effect.fail(Object.assign(new Error("private disk path"), { code: "ENOSPC" }))
                : Effect.sync(() => {
                    received.push(message);
                  }),
            {
              raise: (name) => Effect.sync(() => alerts.push(`raise:${name}`)),
              clear: (name) => Effect.sync(() => alerts.push(`clear:${name}`)),
            },
          );
          return yield* story(started.call);
        }),
      ).pipe(
        Effect.provide(bridge.layer),
        Effect.provide(
          Logger.layer([
            Logger.make((entry) => {
              logs.push(JSON.stringify(entry.message));
            }),
          ]),
        ),
      ),
    );
  return { bridge, alerts, received, logs, run, fail: (value: boolean) => (failing = value) };
};

test("requests wait for the restored session and carry their answers back", async () => {
  const h = harness();
  h.bridge.holdStart(true);
  h.bridge.answer("send", { stage: "input", cause: { code: "invalid_recipient" } });
  h.bridge.answer("typing", { stage: "send", cause: { kind: "send", code: -1 } });
  h.bridge.answer("read", { stage: "send", cause: {} });
  await h.run((call) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => vi.waitFor(() => expect(h.bridge.spawned).toHaveLength(1)));
      const early = yield* call("send", {}).pipe(Effect.flip);
      expect(early).toBeInstanceOf(BridgeUnavailable);
      yield* Effect.promise(() =>
        vi.waitFor(() =>
          expect(h.bridge.requests.map((request) => request.method)).toEqual(["handles"]),
        ),
      );
      const restored = h.bridge.deliver(incoming("tel:+821012345678", "restored", 1));
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(h.bridge.acknowledged).toEqual([restored])),
      );
      expect(yield* call("send", {}).pipe(Effect.flip)).toBeInstanceOf(BridgeUnavailable);
      h.bridge.holdStart(false);
      h.bridge.exit();
      expect(yield* ready(call)).toEqual({ handles: [service] });
      expect(h.bridge.spawned[1]).toEqual({
        command: "ren-rustpush",
        args: ["rpc", service],
        env: options.env,
      });
      const rejected = yield* call("send", {
        guid: "G",
        to: "private-handle",
        text: "private-text",
      }).pipe(Effect.flip);
      expect(rejected).toMatchObject({
        stage: "input",
        code: "invalid_recipient",
      });
      expect(yield* call("typing", {}).pipe(Effect.flip)).toMatchObject({
        stage: "send",
        code: "-1",
      });
      expect(yield* call("read", {}).pipe(Effect.flip)).toMatchObject({ code: "unknown" });
      expect(yield* call("react", {})).toEqual({ status: "sent" });
      h.bridge.raw("not json");
      h.bridge.raw(JSON.stringify({ id: 999, result: { status: "sent" } }));
      expect(yield* call("react", {})).toEqual({ status: "sent" });
    }),
  );
  expect(h.alerts).toContain("clear:rustpush-bridge");
  const rejection = h.logs.filter((line) => line.includes('"code":"invalid_recipient"'));
  expect(rejection).toHaveLength(1);
  expect(rejection[0]).toContain('"causeStage":"input"');
  expect(rejection[0]).toContain('"stage":"rustpush.rpc.send"');
  expect(rejection[0]).toMatch(/"requestId":"[0-9a-f-]{36}"/);
  expect(rejection[0]).toContain('"durationMs":');
  expect(h.logs.join()).not.toContain("private-handle");
  expect(h.logs.join()).not.toContain("private-text");
});

test("events are acknowledged only after they are applied", async () => {
  const h = harness();
  await h.run((call) =>
    Effect.gen(function* () {
      yield* ready(call);
      const message = incoming("tel:+821012345678", "hello", 1_000);
      const spool = h.bridge.deliver(message);
      yield* Effect.promise(() => vi.waitFor(() => expect(h.bridge.acknowledged).toEqual([spool])));
      expect(h.received).toEqual([message]);
      h.fail(true);
      h.bridge.deliver(incoming("tel:+821012345678", "later", 2_000));
      yield* Effect.sleep("30 millis");
      expect(h.bridge.acknowledged).toEqual([spool]);
      const failed = h.logs.filter((line) => line.includes('"code":"ENOSPC"'));
      expect(failed).toHaveLength(1);
      expect(failed[0]).toContain('"stage":"rustpush.event.apply"');
      expect(failed[0]).toContain('"causeName":"Error"');
      expect(failed[0]).toMatch(/"requestId":"[0-9a-f-]{36}"/);
      expect(h.logs.join()).not.toContain("private disk path");
      h.fail(false);
      h.bridge.answer("ack", "exit");
      const lost = h.bridge.deliver(incoming("tel:+821012345678", "unconfirmed", 3_000));
      yield* Effect.promise(() => vi.waitFor(() => expect(h.bridge.acknowledged).toContain(lost)));
      expect(h.received.at(-1)?.guid).toBeDefined();
    }),
  );
});

test("a bridge that ran long enough restarts promptly without alerting", async () => {
  const h = harness(bridgeFixture(), 0);
  await h.run((call) =>
    Effect.gen(function* () {
      yield* ready(call);
      for (let exit = 0; exit < 3; exit++) {
        h.bridge.exit();
        yield* ready(call);
      }
    }),
  );
  expect(h.alerts).not.toContain("raise:rustpush-bridge");
});

test("an exiting bridge leaves its requests in doubt and is restarted, alerting when it keeps exiting", async () => {
  const h = harness();
  h.bridge.failSpawns(1);
  await h.run((call) =>
    Effect.gen(function* () {
      yield* ready(call);
      h.bridge.answer("send", "hang");
      const pending = yield* Effect.forkChild(call("send", {}));
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(h.bridge.requests.at(-1)?.method).toBe("send")),
      );
      h.bridge.answer("handles", "exit", "exit");
      h.bridge.exit();
      const lost = yield* Fiber.join(pending).pipe(Effect.flip);
      expect(lost).toMatchObject({ _tag: "BridgeLost" });
      yield* ready(call);
      expect(h.bridge.spawned.length).toBeGreaterThanOrEqual(3);
    }),
  );
  expect(h.alerts).toContain("raise:rustpush-bridge");
  expect(h.alerts.at(-1)).toBe("clear:rustpush-bridge");
});

test("an unresponsive bridge times out and is restarted without retrying its send", async () => {
  const h = harness(bridgeFixture(), 0, 100);
  await h.run((call) =>
    Effect.gen(function* () {
      yield* ready(call);
      h.bridge.answer("send", "hang");
      expect(yield* call("send", {}).pipe(Effect.flip)).toMatchObject({ _tag: "BridgeLost" });
      yield* ready(call);
      expect(h.bridge.spawned).toHaveLength(2);
      expect(h.bridge.requests.filter((request) => request.method === "send")).toHaveLength(1);
    }),
  );
});
