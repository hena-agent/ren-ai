import { rm } from "node:fs/promises";
import { Effect, Layer, Stream } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { NodeServices } from "@effect/platform-node";
import {
  HttpClient,
  HttpClientResponse,
  FetchHttpClient,
  HttpClientRequest,
} from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { expect, test } from "vitest";
import { messagingFixture } from "../test/messaging.test-helper.ts";
import { composeServer } from "./server.ts";
import { applicationApi } from "./opencode/application-protocol.ts";

test("migration bootstrap serves the persona catalog but cannot send or start AI work", async () => {
  const { root, personaDirectory } = await messagingFixture("bootstrap-");
  const external: string[] = [];
  const offline = HttpClient.make((request) => {
    external.push(request.url);
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response("offline", { status: 503 })),
    );
  });
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* composeServer({
            stateDirectory: root,
            personaDirectory,
            defaultPersonaID: "persona1",
            publicPort: 0,
            bootstrapOnly: true,
            messaging: { url: "https://imsg.invalid/rpc", token: "messaging" },
            opencode: {
              baseUrl: "https://oc.invalid",
              authorization: "Basic test",
              directory: "/srv/ren-ai",
              model: "test/probe",
            },
            secrets: {
              TURNSTILE_SECRET: "turnstile",
              APPLICATION_TOKEN: "application",
              DISCORD_WEBHOOK_URL: "https://discord.invalid",
            },
          });
          expect(server.mode).toBe("bootstrap");
          expect(
            yield* Effect.promise(() =>
              server
                .publicWeb(new Request("https://app.test/onboarding"))
                .then((response) => response.text()),
            ),
          ).toBe("Starting");
          expect(
            (yield* Effect.promise(() =>
              server.publicWeb(new Request("https://app.test/onboarding")),
            )).status,
          ).toBe(503);
          const client = yield* RpcClient.make(applicationApi).pipe(
            Effect.provide(
              RpcClient.layerProtocolHttp({
                url: "https://app.test/rpc",
                transformClient: HttpClient.mapRequest(
                  HttpClientRequest.setHeader("authorization", "Bearer application"),
                ),
              }).pipe(Layer.provide(RpcSerialization.layerNdjson)),
            ),
            Effect.provide(FetchHttpClient.layer),
            Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
              server.publicWeb(new Request(input, init)),
            ),
          );
          expect((yield* client.catalog()).map((persona) => persona.id)).toEqual(["persona1"]);
          expect(
            yield* client
              .send({ sessionID: "existing", text: "must not send", callID: "migration" })
              .pipe(Effect.flip),
          ).toBe("Error: Application is in migration mode");
          expect(yield* client.read({ sessionID: "existing" }).pipe(Effect.flip)).toBe(
            "Error: Application is in migration mode",
          );
          expect(
            yield* client
              .react({ sessionID: "existing", tapback: "love", callID: "reaction" })
              .pipe(Effect.flip),
          ).toBe("Error: Application is in migration mode");
          expect(
            yield* client
              .wait({ sessionID: "existing", minutes: 1 })
              .pipe(Stream.runDrain, Effect.flip),
          ).toBe("Error: Application is in migration mode");
          expect(external).toEqual([]);
        }).pipe(
          Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
          Effect.provide(NodeServices.layer),
          Effect.provideService(HttpClient.HttpClient, offline),
        ),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
