import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { fakeGestures, fakeMessages } from "@ren-ai/imsg/testing";
import { rpcClient } from "@ren-ai/transport/client";
import { expect, test } from "vitest";
import { runMessagingTest, silentAlerts } from "../../test/messaging.test-helper.ts";
import { applicationRequest } from "../application-request.ts";
import { prepareMessaging } from "../application-tools.ts";
import { applicationGateway } from "../opencode/application-gateway.ts";
import { applicationApi } from "../opencode/application-protocol.ts";
import { fixture, input } from "./photos.test-helper.ts";

test("provider failures retain the server-generated HTTP request ID through the actual photo RPC", () =>
  runMessagingTest(
    Effect.gen(function* () {
      const f = yield* fixture;
      f.fetcher.mockResolvedValueOnce(
        Response.json(
          { error: { message: "private scene private key", code: "overloaded" } },
          { status: 503 },
        ),
      );
      const prepared = yield* prepareMessaging(
        f.options.personas,
        fakeMessages().messages,
        fakeGestures().gestures,
        f.photos,
      );
      const web = applicationGateway(prepared.tools, silentAlerts, "application-secret");
      yield* Effect.addFinalizer(() => Effect.promise(web.dispose));
      let responseId: string | null = null;
      const client = yield* rpcClient(applicationApi, {
        url: "https://app.test/rpc",
        token: "application-secret",
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, async (url, init) => {
          const response = await applicationRequest(new Request(url, init), web.handler);
          responseId = response.headers.get("X-Request-ID");
          return response;
        }),
      );
      expect(
        yield* client.takePhoto(
          { sessionID: f.conversation.sessionID, callID: "private-call", input },
          { headers: { "x-operation-id": "private-forged-id" } },
        ),
      ).toEqual({ status: "declined" });
      expect(responseId).toMatch(/^[0-9a-f-]{36}$/);
      const events = f.log.mock.calls.map(([event]) => event);
      expect(events.filter((event) => event.outcome === "failed")).toHaveLength(1);
      expect(events.find((event) => event.outcome === "failed")).toMatchObject({
        requestId: responseId,
        stage: "generation",
        upstreamStatus: 503,
        code: "overloaded",
        personaId: "persona1",
        model: "gpt-image-2.5",
      });
      expect(events.find((event) => event.stage === "complete")?.requestId).toBe(responseId);
      expect(JSON.stringify(events)).not.toMatch(
        /private scene|private key|private-call|private-forged|private handle|application-secret/,
      );
    }),
  ));
