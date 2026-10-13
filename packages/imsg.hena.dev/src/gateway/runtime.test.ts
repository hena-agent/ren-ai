import { Server } from "node:http";
import { ConfigProvider, Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { expect, test, vi } from "vitest";
import { fixture, raw } from "../messages/imsg.fake.ts";
import { listenerUrl } from "../../test/listener.test-helper.ts";
import { remoteMessages } from "./client.ts";
import { startMessagingGateway } from "./runtime.ts";

test("the independently configured Mac service starts with only messaging credentials", async () => {
  const imsg = fixture();
  const logs: string[] = [];
  const logging = vi.spyOn(console, "log").mockImplementation((...values) => {
    logs.push(values.map(String).join(" "));
  });
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* startMessagingGateway;
          const address = service.listener.address();
          expect(address).toMatchObject({ address: "127.0.0.1" });
          expect(address).not.toMatchObject({ port: 4702 });
          const remote = yield* remoteMessages({
            url: `${listenerUrl(service.listener)}/rpc`,
            token: "only-messaging",
          });
          expect((yield* remote.after(0)).map((row) => row.guid)).toEqual(
            raw.map((row) => row.guid),
          );
          expect(yield* remote.sendText("+821012345678", "isolated")).toEqual({
            guid: raw[0]!.guid,
          });
          expect(
            imsg.commands.some(
              (command) => command.method === "send" && command.params["service"] === "imessage",
            ),
          ).toBe(true);
          imsg.fail();
          for (let attempt = 0; attempt < 3; attempt++) {
            expect(
              (yield* remote.sendText("+821012345678", "uncertain").pipe(Effect.flip)).message,
            ).toContain("imsg send uncertain; reconcile outgoing rows before retry");
          }
          imsg.succeed();
          yield* remote.sendText("+821012345678", "recovered");
        }).pipe(
          Effect.provide(imsg.dependencies),
          Effect.provide(FetchHttpClient.layer),
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({ IMSG_TOKEN: "only-messaging", IMSG_PORT: "0" }),
            ),
          ),
        ),
      ),
    );
    expect(logs.some((line) => line.includes("imsg-sends: Repeated imsg send failures"))).toBe(
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
    const imsg = fixture();
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
          Effect.provide(imsg.dependencies),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(configuration))),
        ),
      );
      expect(requested).toEqual(expected);
    } finally {
      listen.mockRestore();
    }
  },
);
