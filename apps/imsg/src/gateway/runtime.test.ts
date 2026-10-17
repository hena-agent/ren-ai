import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigProvider, Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { afterEach, expect, test, vi } from "vitest";
import { bridgeFixture, service } from "../../test/bridge.test-helper.ts";
import { listenerUrl } from "../../test/listener.test-helper.ts";
import { remoteMessages } from "./client.ts";
import { startMessagingGateway } from "./runtime.ts";

const homes: string[] = [];
const home = () => {
  const directory = mkdtempSync(join(tmpdir(), "imsg-home-"));
  homes.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of homes.splice(0)) rmSync(directory, { recursive: true });
});

test("the independently configured Mac service starts with only messaging credentials", async () => {
  const bridge = bridgeFixture();
  const directory = home();
  bridge.answer(
    "send",
    { status: "sent" },
    ...Array.from({ length: 3 }, () => ({ stage: "send", cause: { code: "unconfirmed" } })),
  );
  const logs: string[] = [];
  const logging = vi.spyOn(console, "log").mockImplementation((...values) => {
    logs.push(values.map(String).join(" "));
  });
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const gateway = yield* startMessagingGateway;
          expect(gateway.listener.address()).toMatchObject({ address: "127.0.0.1" });
          expect(gateway.listener.address()).not.toMatchObject({ port: 4702 });
          const remote = yield* remoteMessages({
            url: `${listenerUrl(gateway.listener)}/rpc`,
            token: "only-messaging",
          });
          yield* Effect.promise(() => vi.waitFor(() => Effect.runPromise(remote.probe())));
          const health = () =>
            fetch(`${listenerUrl(gateway.listener)}/health`, {
              headers: { Authorization: "Bearer only-messaging" },
            });
          bridge.answer("handles", { stage: "apns", cause: { code: "not_ready" } });
          const degraded = yield* Effect.promise(health);
          expect(degraded.status).toBe(503);
          expect(degraded.headers.get("X-Request-ID")).toMatch(/^[0-9a-f-]{36}$/);
          expect(yield* Effect.promise(() => degraded.json())).toMatchObject({
            status: "degraded",
          });
          expect((yield* Effect.promise(health)).status).toBe(200);
          expect(bridge.spawned[0]).toEqual({
            command: join(directory, "ren-rustpush"),
            args: ["rpc", service],
            env: { RUSTPUSH_STATE_DIR: join(directory, "rustpush") },
          });
          const { guid } = yield* remote.sendText("+821012345678", "isolated");
          expect(bridge.requests.find((request) => request.method === "send")?.params).toEqual({
            guid,
            to: "tel:+821012345678",
            text: "isolated",
          });
          expect(yield* remote.sendStatus(guid!)).toBe("sent");
          for (let attempt = 0; attempt < 3; attempt++)
            yield* remote.sendText("+821012345678", "uncertain");
          expect((yield* remote.after(0)).map((row) => row.text)).toEqual([
            "isolated",
            "uncertain",
            "uncertain",
            "uncertain",
          ]);
          expect(existsSync(join(directory, "history.sqlite"))).toBe(true);
        }).pipe(
          Effect.provide(bridge.layer),
          Effect.provide(FetchHttpClient.layer),
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                IMSG_TOKEN: "only-messaging",
                IMSG_PORT: "0",
                IMSG_HOME: directory,
              }),
            ),
          ),
        ),
      ),
    );
    expect(logs.some((line) => line.includes("rustpush-sends: Repeated sends in doubt"))).toBe(
      true,
    );
  } finally {
    logging.mockRestore();
  }
});

test.each([
  { configuration: { IMSG_TOKEN: "native-secret" }, expected: { port: 4702, host: "127.0.0.1" } },
  {
    configuration: {
      IMSG_TOKEN: "native-secret",
      IMSG_PORT: "12345",
      IMSG_LISTEN_HOST: "localhost",
    },
    expected: { port: 12345, host: "localhost" },
  },
])(
  "the native service applies its documented listener configuration ($expected)",
  async ({ configuration, expected }) => {
    const bridge = bridgeFixture();
    let requested: { port: number; host: string } | undefined;
    const listen = vi.spyOn(Server.prototype, "listen").mockImplementation(function (
      this: Server,
      ...args
    ) {
      requested = Schema.decodeUnknownSync(
        Schema.Struct({ port: Schema.Number, host: Schema.String }),
      )(args[0]);
      // Observe the external socket API but bind an ephemeral port, never a deployment port.
      args[0] = { ...requested, port: 0 };
      listen.mockRestore();
      return Reflect.apply(this.listen.bind(this), this, args);
    });
    try {
      await Effect.runPromise(
        Effect.scoped(startMessagingGateway).pipe(
          Effect.provide(bridge.layer),
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({ ...configuration, IMSG_HOME: home() }),
            ),
          ),
        ),
      );
      expect(requested).toEqual(expected);
    } finally {
      listen.mockRestore();
    }
  },
);
