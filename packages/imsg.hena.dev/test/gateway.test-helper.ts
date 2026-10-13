import { Effect, Scope } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { fakeMessages } from "../src/messages/messages.fake.ts";
import { fakeGestures } from "../src/gestures/gestures.fake.ts";
import { messageGateway } from "../src/gateway/server.ts";
import { remoteMessages } from "../src/gateway/client.ts";
import type { Messages } from "../src/messages/messages.ts";

export const gatewayFixture = (messages?: Messages) => {
  const local = fakeMessages();
  const gestures = fakeGestures();
  const server = messageGateway(messages ?? local.messages, "secret", gestures.gestures);
  const transport = { fetch: server.handler };
  const request = (tag: string, payload: object) =>
    server.handler(
      new Request("https://imsg.test/rpc", {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/ndjson" },
        body: `${JSON.stringify({ _tag: "Request", id: 0, tag, payload, headers: [] })}\n`,
      }),
    );
  const run = <A, E>(
    story: (
      remote: Effect.Success<ReturnType<typeof remoteMessages>>,
    ) => Effect.Effect<A, E, Scope.Scope>,
  ) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(remoteMessages({ url: "https://imsg.test/rpc", token: "secret" }), story),
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
          transport.fetch(new Request(input, init)),
        ),
      ),
    );
  return { local, gestures, server, transport, request, run };
};
