import { Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { prepareMessaging } from "../src/application-tools.ts";
import { fakeMessages } from "../src/messages/messages.fake.ts";
import { fakeGestures } from "../src/gestures/gestures.fake.ts";
import { applicationGateway } from "../src/opencode/application-gateway.ts";
import { applicationApi } from "../src/opencode/application-protocol.ts";
import { rpcClient } from "../src/transport/rpc.ts";
import { registration, silentAlerts } from "./messaging.test-helper.ts";

export const malformedRpcReply = async (request: Request, value: object): Promise<Response> => {
  const requestID = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ id: Schema.Number })),
  )(await request.text()).id;
  return new Response(
    `${JSON.stringify({ _tag: "Exit", requestId: requestID, exit: { _tag: "Success", value } })}\n`,
  );
};

export const applicationRpcFixture = Effect.gen(function* () {
  const messages = fakeMessages();
  const gestures = fakeGestures();
  const persona = {
    id: "persona1",
    timeZone: "Asia/Seoul",
    language: "ko",
    openingLine: "Hi",
    memory: "Remember.",
    prompt: "You are Persona1.",
  };
  const prepared = yield* prepareMessaging(
    new Map([[persona.id, persona]]),
    messages.messages,
    gestures.gestures,
  );
  const conversation = yield* prepared.directory.create(
    registration("application@example.com", "session"),
  );
  const alerts: { name: string; detail: string }[] = [];
  const web = applicationGateway(
    prepared.tools,
    {
      ...silentAlerts,
      raise: (name, detail) =>
        Effect.sync(() => {
          alerts.push({ name, detail: detail ?? name });
        }),
    },
    "application-secret",
  );
  yield* Effect.addFinalizer(() => Effect.promise(web.dispose));
  const transport = { fetch: web.handler };
  const client = yield* rpcClient(applicationApi, {
    url: "https://app.test/rpc",
    token: "application-secret",
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
      transport.fetch(new Request(input, init)),
    ),
  );
  const request = (tag: string, payload: object) =>
    web.handler(
      new Request("https://app.test/rpc", {
        method: "POST",
        headers: {
          authorization: "Bearer application-secret",
          "content-type": "application/ndjson",
        },
        body: `${JSON.stringify({ _tag: "Request", id: 0, tag, payload, headers: [] })}\n`,
      }),
    );
  return {
    messages,
    gestures,
    persona,
    prepared,
    conversation,
    alerts,
    web,
    transport,
    client,
    request,
  };
});
