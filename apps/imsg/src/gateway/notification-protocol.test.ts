import { Effect, Layer } from "effect";
import { RpcGroup, RpcServer } from "effect/unstable/rpc";
import { rpcRouter } from "@ren-ai/transport/server";
import { expect, test } from "vitest";
import { captureGatewayLogs, gatewayFixture } from "../../test/gateway.test-helper.ts";
import { sendTextRpc } from "./protocol.ts";

const persistenceFailure = () =>
  Effect.fail(Object.assign(new Error("private-sql-path"), { code: "SQLITE_FULL" }));

test("a submitted Notification returns its GUID even when status reads fail", async () => {
  const f = gatewayFixture();
  f.notifications.status = persistenceFailure;
  try {
    await f.run((remote) =>
      Effect.gen(function* () {
        expect((yield* remote.notify("+821012345678", "one attempt")).guid).toBe("fake-1");
      }),
    );
  } finally {
    await f.server.dispose();
  }
});

test("an older Mac rejects notify rather than sending from the Persona handle", async () => {
  const f = gatewayFixture();
  const legacy = RpcGroup.make(sendTextRpc);
  // Only the existing send endpoint is needed to detect an accidental fallback.
  const routes = RpcServer.layerHttp({ group: legacy, path: "/rpc", protocol: "http" });
  const old = rpcRouter(
    routes.pipe(
      Layer.provide(
        legacy.toLayer({
          sendText: ({ handle, text }) =>
            f.local.messages.sendText(handle, text).pipe(Effect.mapError(String)),
        }),
      ),
    ),
    "secret",
  );
  f.transport.fetch = old.handler;
  try {
    await f.run((remote) =>
      Effect.gen(function* () {
        expect(yield* remote.notify("+821012345678", "private").pipe(Effect.flip)).toBeInstanceOf(
          Error,
        );
        expect((yield* remote.notificationStatus("missing").pipe(Effect.flip)).message).toContain(
          "Notification RPC unavailable",
        );
        expect(f.local.bubbles).toEqual([]);
        expect((yield* remote.availability("+821012345678").pipe(Effect.flip)).message).toContain(
          "Availability RPC unavailable",
        );
        const attemptID = crypto.randomUUID();
        for (const effect of [
          remote.sendText("user@example.test", "private", attemptID).pipe(Effect.asVoid),
          remote.resolveSend(attemptID).pipe(Effect.asVoid),
        ]) {
          expect((yield* effect.pipe(Effect.flip)).message).toContain(
            "Identified send RPC unavailable",
          );
        }
        expect(f.local.bubbles).toEqual([]);
        yield* remote.sendText("+821012345678", "persona");
        expect(f.local.bubbles).toEqual([{ handle: "+821012345678", text: "persona" }]);
      }),
    );
  } finally {
    await old.dispose();
    await f.server.dispose();
  }
});

test("Notification RPC failures return safe correlated errors and diagnose persistence failures", async () => {
  const f = gatewayFixture();
  const { logs, restore } = captureGatewayLogs();
  try {
    await f.run((remote) =>
      Effect.gen(function* () {
        const { guid } = yield* remote.notify("+821012345678", "notification");
        expect((yield* remote.notificationStatus(guid)).state).toBe("sent");
        expect(f.local.bubbles).toEqual([]);
        f.notifications.sendText = persistenceFailure;
        f.notifications.status = persistenceFailure;
        f.local.messages.sendText = persistenceFailure;
        f.local.messages.resolveSend = persistenceFailure;
        for (const call of [
          remote.notify("+821012345678", "private-text").pipe(Effect.asVoid),
          remote.notificationStatus(guid).pipe(Effect.asVoid),
          remote.sendText("+821012345678", "private-text", crypto.randomUUID()).pipe(Effect.asVoid),
          remote.resolveSend(crypto.randomUUID()).pipe(Effect.asVoid),
        ]) {
          const error = yield* call.pipe(Effect.flip);
          const requestId = error.message.match(/request ([0-9a-f-]{36})/)?.[1];
          expect(requestId).toBeDefined();
          expect(logs.filter((line) => line.includes(requestId!)).join("\n")).toContain(
            "SQLITE_FULL",
          );
          expect(error.message).not.toContain("private-sql-path");
        }
      }),
    );
    for (const secret of ["private-sql-path", "private-text", "+821012345678"])
      expect(logs.join("\n")).not.toContain(secret);
  } finally {
    restore();
    await f.server.dispose();
  }
});
