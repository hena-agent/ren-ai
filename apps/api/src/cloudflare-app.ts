import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { createApplicationStore } from "./application-store.ts";
import type { ApplicationStore } from "./application-store.ts";
import { cloudflareConfiguration } from "./cloudflare-config.ts";
import type { CloudflareBindings, CloudflareConfiguration } from "./cloudflare-config.ts";
import { createExecutionRuntime } from "./execution-runtime.ts";
import { applicationRequest } from "./application-request.ts";
import { stateTransfer } from "./state-transfer.ts";
import { healthResponse, probeHealth } from "@ren-ai/transport/health";
import { contactCause, contactLog } from "./discovery/diagnostics.ts";

export interface CloudflareApplication {
  readonly store: ApplicationStore;
  readonly configuration: CloudflareConfiguration;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly close: () => Promise<void>;
  readonly tick: () => Promise<void>;
}

const isWriteRequest = (request: Request) =>
  request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS";

const health = async (
  request: Request,
  store: ApplicationStore,
  configuration: CloudflareConfiguration,
  fetcher: typeof fetch,
) => {
  const requestId = request.headers.get("X-Operation-ID")!;
  const databaseStarted = performance.now();
  let database: "ready" | "unavailable" = "ready";
  try {
    await store.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`SELECT 1`;
      }),
    );
  } catch (cause) {
    database = "unavailable";
    contactLog({
      requestId,
      operation: "api-app.health",
      stage: "database.probe",
      outcome: "failed",
      durationMs: performance.now() - databaseStarted,
      level: "error",
      code: "database_probe_failed",
      status: 503,
      ...contactCause(cause),
    });
  }
  const executorStarted = performance.now();
  const executor = await probeHealth(
    configuration.execution.apiMsgUrl,
    "api-msg",
    configuration.execution.managementToken,
    fetcher,
  );
  if (executor.status !== "ready")
    contactLog({
      requestId,
      operation: "api-app.health",
      stage: "executor.probe",
      outcome: "failed",
      durationMs: performance.now() - executorStarted,
      level: executor.status === "unauthorized" ? "warn" : "error",
      code: `executor_${executor.status}`,
      status: 503,
    });
  return healthResponse(
    "api-app",
    database === "ready" && executor.status === "ready" ? "ready" : "degraded",
    {
      database,
      storage: "durable-object-sqlite",
      bootstrapOnly: configuration.bootstrapOnly,
      executor,
    },
  );
};

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
            return health(request, store, configuration, fetcher);
          if (path.startsWith("/management/state/"))
            return stateTransfer(
              request,
              store,
              configuration.applicationStore.managementToken,
              configuration.bootstrapOnly,
            );
          if (configuration.bootstrapOnly && isWriteRequest(request)) return bootstrapResponse();
          if (
            path.startsWith("/rpc") ||
            path.startsWith("/operator/") ||
            path === "/management/catalog/refresh"
          ) {
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
          try {
            if (runtime) await (await runtime).close();
          } finally {
            await store.close();
          }
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
