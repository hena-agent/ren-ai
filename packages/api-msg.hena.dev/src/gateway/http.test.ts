import { Deferred, Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { expect, test } from "vitest";
import { gatewayFixture } from "../../test/gateway.test-helper.ts";
import { servePublic } from "../public-listener.ts";
import { remoteMessages } from "./client.ts";
import { listenerUrl } from "../../test/server.test-helper.ts";

test("the messaging listener delivers stream rows before the HTTP response ends", async () => {
  const fixture = gatewayFixture();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const listener = yield* servePublic(fixture.server.handler, 0);
          const remote = yield* remoteMessages({
            url: `${listenerUrl(listener)}/rpc`,
            token: "secret",
          });
          const received = yield* Deferred.make<string>();
          const stop = yield* remote.follow(0, (row) =>
            Deferred.succeed(received, row.text).pipe(Effect.asVoid),
          );
          yield* fixture.local.text("+821012345678", "streamed", 100);
          expect(yield* Deferred.await(received).pipe(Effect.timeout("2 seconds"))).toBe(
            "streamed",
          );
          expect(yield* remote.sendText("+821012345678", "over HTTP")).toEqual({ guid: "fake-1" });
          stop();
        }).pipe(Effect.provide(FetchHttpClient.layer)),
      ),
    );
  } finally {
    await fixture.server.dispose();
  }
});

test("an idle messaging stream can stop without waiting for the first message", async () => {
  const fixture = gatewayFixture();
  const requests: string[] = [];
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const requested = yield* Deferred.make<void>();
          const listener = yield* servePublic((request) => {
            requests.push(request.method);
            Effect.runSync(Deferred.succeed(requested, undefined));
            return fixture.server.handler(request);
          }, 0);
          const remote = yield* remoteMessages({
            url: `${listenerUrl(listener)}/rpc`,
            token: "secret",
          });
          const stop = yield* remote.follow(0, () => Effect.void);
          yield* Deferred.await(requested);
          stop();
        }).pipe(Effect.provide(FetchHttpClient.layer)),
      ),
    );
    expect(requests).toEqual(["POST"]);
  } finally {
    await fixture.server.dispose();
  }
}, 3000);
