import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { createApplicationStore } from "./application-store.ts";
import type { ApplicationStore } from "./application-store.ts";
import { cloudflareConfiguration } from "./cloudflare-config.ts";
import type { CloudflareBindings, CloudflareConfiguration } from "./cloudflare-config.ts";
import { createExecutionRuntime } from "./execution-runtime.ts";
import { applicationRequest } from "./application-request.ts";
import { stateTransfer } from "./state-transfer.ts";

export interface CloudflareApplication {
  readonly store: ApplicationStore;
  readonly configuration: CloudflareConfiguration;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly close: () => Promise<void>;
  readonly tick: () => Promise<void>;
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
  groundRules: string,
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
    let runtime: ReturnType<typeof createExecutionRuntime> | undefined;
    const execution = () =>
      (runtime ??= createExecutionRuntime(store, configuration, bindings, groundRules, fetcher));
    return {
      store,
      configuration,
      fetch: (incoming) =>
        applicationRequest(incoming, async (request) => {
          const path = new URL(request.url).pathname;
          if (path === "/health" && request.method === "GET")
            return health(configuration.bootstrapOnly);
          if (path.startsWith("/management/state/"))
            return stateTransfer(
              request,
              store,
              bindings.TOKEN_MANAGEMENT,
              configuration.bootstrapOnly,
            );
          if (configuration.bootstrapOnly && isWriteRequest(request)) return bootstrapResponse();
          if (path.startsWith("/rpc") || path.startsWith("/operator/")) {
            if (configuration.bootstrapOnly) return bootstrapResponse();
            return (await execution()).fetch(request);
          }
          return store.handler(request);
        }),
      tick: async () => {
        if (configuration.bootstrapOnly) return;
        try {
          await (await execution()).tick();
        } catch (cause) {
          if (runtime) await runtime.then((value) => value.close()).catch(() => {});
          runtime = undefined;
          throw cause;
        }
      },
      close: async () => {
        try {
          if (runtime) await (await runtime).close();
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
