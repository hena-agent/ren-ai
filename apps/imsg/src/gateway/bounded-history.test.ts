import { Effect, Layer, Schema } from "effect";
import { Rpc, RpcGroup, RpcServer } from "effect/unstable/rpc";
import { expect, test } from "vitest";
import { rpcRouter } from "@ren-ai/transport/server";
import { incomingMessage } from "./protocol.ts";
import { gatewayFixture } from "../../test/gateway.test-helper.ts";

test("bounded history works with the new Mac and remains readable from the deployed unbounded protocol", async () => {
  const f = gatewayFixture();
  const previous = RpcGroup.make(
    Rpc.make("after", {
      payload: { rowID: Schema.Number },
      success: Schema.Array(incomingMessage),
      error: Schema.String,
    }),
  );
  const oldServer = rpcRouter(
    RpcServer.layerHttp({ group: previous, path: "/rpc", protocol: "http" }).pipe(
      Layer.provide(
        previous.toLayer({
          after: ({ rowID }) => f.local.messages.after(rowID).pipe(Effect.mapError(String)),
        }),
      ),
    ),
    "secret",
  );
  try {
    await f.run((remote) =>
      Effect.gen(function* () {
        const first = yield* f.local.text("synthetic", "first", 1);
        const second = yield* f.local.text("synthetic", "second", 2);
        expect(yield* remote.after(0, 1)).toEqual([first]);
        expect(yield* remote.after(first.id, 1)).toEqual([second]);
        expect(yield* remote.after(0)).toEqual([first, second]);
        f.transport.fetch = oldServer.handler;
        expect(yield* remote.after(0, 1)).toEqual([first, second]);
        const failure = yield* remote
          .history({ handle: first.handle, since: 0, until: null })
          .pipe(Effect.flip);
        expect(failure.message).toContain("Message history RPC unavailable");
      }),
    );
  } finally {
    await oldServer.dispose();
    await f.server.dispose();
  }
});
