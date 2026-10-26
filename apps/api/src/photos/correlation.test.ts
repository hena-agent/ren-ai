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

test.each(["http", "network", "unsafe-cause"] as const)(
  "%s provider failures retain correlation and safe underlying causes through the photo RPC",
  (kind) =>
    runMessagingTest(
      Effect.gen(function* () {
        const f = yield* fixture;
        if (kind === "http")
          f.fetcher.mockResolvedValueOnce(
            Response.json(
              { error: { message: "private scene private key", code: "overloaded" } },
              { status: 503 },
            ),
          );
        else
          f.fetcher.mockRejectedValueOnce(
            new Error("private scene", {
              cause: Object.assign(new Error("private key"), {
                name: kind === "network" ? "SocketError" : "private key",
                code: kind === "network" ? "ECONNRESET" : "private scene",
              }),
            }),
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
          ...(kind === "http"
            ? { upstreamStatus: 503, code: "overloaded" }
            : { code: "network_error" }),
          personaId: "persona1",
          model: "gpt-image-2.5",
        });
        if (kind === "network")
          expect(events.find((event) => event.outcome === "failed")).toMatchObject({
            causeName: "SocketError",
            causeCode: "ECONNRESET",
          });
        if (kind === "unsafe-cause")
          expect(events.find((event) => event.outcome === "failed")).not.toHaveProperty(
            "causeCode",
          );
        expect(events.find((event) => event.stage === "complete")?.requestId).toBe(responseId);
        expect(JSON.stringify(events)).not.toMatch(
          /private scene|private key|private-call|private-forged|private handle|application-secret/,
        );
      }),
    ),
);
