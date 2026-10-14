import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { createApplicationStore } from "./application-store.ts";
import type { ApplicationStore } from "./application-store.ts";
import { cloudflareConfiguration } from "./cloudflare-config.ts";
import type { CloudflareBindings, CloudflareConfiguration } from "./cloudflare-config.ts";

export interface CloudflareApplication {
  readonly store: ApplicationStore;
  readonly configuration: CloudflareConfiguration;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly close: () => Promise<void>;
}

const isWriteRequest = (request: Request) =>
  request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS";

const health = (bootstrapOnly: boolean) =>
  Response.json(
    { database: "ready", storage: "durable-object-sqlite", bootstrapOnly },
    { headers: { "Cache-Control": "no-store" } },
  );

const bootstrapResponse = () =>
  Response.json(
    { error: "bootstrap_only" },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );

export const createCloudflareApplication = async (
  storage: DurableObjectStorage,
  bindings: CloudflareBindings,
  fetcher: typeof fetch = fetch,
): Promise<CloudflareApplication> => {
  const httpScope = await Effect.runPromise(Scope.make());
  try {
    const services = await Effect.runPromise(
      Layer.buildWithScope(FetchHttpClient.layer, httpScope).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetcher),
      ),
    );
    const configuration = cloudflareConfiguration(bindings, fetcher);
    const store = await createApplicationStore(storage, {
      ...configuration.applicationStore,
      httpClient: Context.get(services, HttpClient.HttpClient),
    });
    return {
      store,
      configuration,
      fetch: (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/health" && request.method === "GET")
          return Promise.resolve(health(configuration.bootstrapOnly));
        if (configuration.bootstrapOnly && isWriteRequest(request))
          return Promise.resolve(bootstrapResponse());
        return store.handler(request);
      },
      close: async () => {
        try {
          await store.close();
        } finally {
          await Effect.runPromise(Scope.close(httpScope, Exit.succeed(undefined)));
        }
      },
    };
  } catch (cause) {
    await Effect.runPromise(Scope.close(httpScope, Exit.fail(cause)));
    throw cause;
  }
};
