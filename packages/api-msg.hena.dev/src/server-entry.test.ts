import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { expect, test } from "vitest";
import { withServerEntry } from "../test/server-entry-process.test-helper.ts";
import { applicationApi } from "./opencode/application-protocol.ts";

test("the actual Bun entry keeps its SQLite layer alive for HTTP callbacks after startup", () =>
  withServerEntry(({ url, backendRequests }) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(applicationApi).pipe(
            Effect.provide(
              RpcClient.layerProtocolHttp({
                url: `${url}/rpc`,
                transformClient: HttpClient.mapRequest(
                  HttpClientRequest.setHeader("authorization", "Bearer test-application"),
                ),
              }).pipe(Layer.provide(RpcSerialization.layerNdjson)),
            ),
          );
          expect((yield* client.catalog()).map((persona) => persona.id)).toEqual(["persona1"]);
          for (const sessionID of ["existing", "next-context", "existing"]) {
            yield* client.context({ sessionID });
            expect(yield* client.sends({ sessionID })).toEqual([]);
            expect(yield* client.handle({ sessionID })).toBeUndefined();
          }
          const onboarding = yield* Effect.promise(() => fetch(`${url}/onboarding`));
          expect(onboarding.status).toBe(503);
          expect(
            yield* client
              .send({ sessionID: "existing", text: "must stay paused", callID: "pause" })
              .pipe(Effect.flip),
          ).toContain("migration mode");
          expect(backendRequests).toEqual([]);
        }),
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  ));
