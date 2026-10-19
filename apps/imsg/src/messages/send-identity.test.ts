import { Effect, Fiber } from "effect";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, incoming, rustpushFixture } from "../../test/bridge.test-helper.ts";
import { captureGatewayLogs, gatewayFixture } from "../../test/gateway.test-helper.ts";

afterEach(cleanup);
const handle = "identity@example.test";

test("interrupting an admitted caller leaves one native submission owned by the gateway", async () => {
  const f = rustpushFixture();
  const guid = crypto.randomUUID().toUpperCase();
  f.bridge.answer("send", "hang");
  await f.run(({ messages }) =>
    Effect.gen(function* () {
      const sending = yield* messages.sendText(handle, "once", guid).pipe(Effect.forkScoped);
      yield* Effect.promise(() =>
        vi.waitFor(() =>
          expect(f.bridge.requests.filter((r) => r.method === "send")).toHaveLength(1),
        ),
      );
      yield* Fiber.interrupt(sending);
      expect(yield* messages.resolveSend(guid)).toBe("unknown");
      yield* messages.sendText(handle, "once", guid);
      expect(f.bridge.requests.filter((r) => r.method === "send")).toHaveLength(1);
      const request = f.bridge.requests.find((r) => r.method === "send")!;
      f.bridge.raw(JSON.stringify({ id: request.id, result: { status: "sent" } }));
      yield* Effect.promise(() =>
        vi.waitFor(async () =>
          expect(await Effect.runPromise(messages.resolveSend(guid))).toBe("sent"),
        ),
      );
    }),
  );
});

test("send identity conflicts cannot target another handle or an incoming history row", async () => {
  const f = rustpushFixture();
  await f.run(({ messages }) =>
    Effect.gen(function* () {
      const id = crypto.randomUUID().toUpperCase();
      yield* messages.sendText(handle, "once", id);
      expect(
        (yield* messages.sendText("other@example.test", "once", id).pipe(Effect.flip)).cause,
      ).toEqual(new Error("Send identity conflict"));
      const row = incoming(`mailto:${handle}`, "incoming", 1);
      f.bridge.deliver(row);
      yield* Effect.promise(() => vi.waitFor(() => expect(f.bridge.acknowledged).toHaveLength(1)));
      expect(
        (yield* messages.sendText(handle, "incoming", row.guid).pipe(Effect.flip)).cause,
      ).toEqual(new Error("Send identity conflict"));
      expect(f.bridge.requests.filter((r) => r.method === "send")).toHaveLength(1);
    }),
  );
});

test("identified RPCs correlate native diagnostics and exclude private message data", async () => {
  const f = rustpushFixture();
  const captured = captureGatewayLogs();
  try {
    await f.run(({ messages }) =>
      Effect.promise(async () => {
        const gateway = gatewayFixture(messages);
        try {
          f.bridge.answer("send", {
            stage: "send",
            cause: { code: "unconfirmed", detail: "private upstream" },
          });
          await gateway.run((remote) =>
            Effect.gen(function* () {
              const guid = crypto.randomUUID().toUpperCase();
              const result = yield* remote.sendText(handle, "private text", guid);
              const native = f.bridge.requests.find((r) => r.method === "send")!;
              expect(result).toMatchObject({ guid, requestId: native.requestId });
              expect(yield* remote.resolveSend(guid)).toBe("unknown");
              const logs = captured.logs
                .filter((line) => line.includes(native.requestId))
                .join("\n");
              expect(logs).toContain("unconfirmed");
              expect(logs).toContain('"causeStage":"send"');
              expect(logs).toContain("send.submit");
            }),
          );
        } finally {
          await gateway.server.dispose();
        }
      }),
    );
    for (const secret of [handle, "private text", "private upstream", "secret"])
      expect(captured.logs.join("\n")).not.toContain(secret);
  } finally {
    captured.restore();
  }
});
