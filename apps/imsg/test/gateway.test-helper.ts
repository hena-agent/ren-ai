import { Effect, Scope } from "effect";
import { vi } from "vitest";
import { FetchHttpClient } from "effect/unstable/http";
import { fakeMessages } from "../src/messages/messages.fake.ts";
import { fakeGestures } from "../src/gestures/gestures.fake.ts";
import { fakeNotifications } from "../src/messages/notifications.fake.ts";
import { messageGateway } from "../src/gateway/server.ts";
import { remoteMessages } from "../src/gateway/client.ts";
import type { Messages } from "../src/messages/messages.ts";

export const captureGatewayLogs = () => {
  const logs: string[] = [];
  const logging = vi.spyOn(console, "log").mockImplementation((...values) => {
    logs.push(JSON.stringify(values));
  });
  return { logs, restore: () => logging.mockRestore() };
};

export const gatewayFixture = (messages?: Messages, notifications = fakeNotifications()) => {
  const local = fakeMessages();
  const gestures = fakeGestures();
  const server = messageGateway(
    messages ?? local.messages,
    "secret",
    gestures.gestures,
    notifications,
  );
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
  return { local, gestures, notifications, server, transport, request, run };
};
