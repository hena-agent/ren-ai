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
import { contactCause, contactLog, contactOperationId } from "./discovery/diagnostics.ts";
import { intakeRequests } from "./intake/http.ts";
import { probeMessaging } from "./messaging-health.ts";
import { discordState, type Webhooks } from "./metrics/discord.ts";

export interface CloudflareApplication {
  readonly store: ApplicationStore;
  readonly configuration: CloudflareConfiguration;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly close: () => Promise<void>;
  readonly tick: (requestId?: string) => Promise<void>;
}

const isWriteRequest = (request: Request) =>
  request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS";

const health = async (
  request: Request,
  store: ApplicationStore,
  configuration: CloudflareConfiguration,
  fetcher: typeof fetch,
  webhooks: Webhooks,
) => {
  const requestId = request.headers.get("X-Operation-ID")!;
  const databaseStarted = performance.now();
  let database: "ready" | "unavailable" = "ready";
  let discord: { alerts: string; reports: string } = {
    alerts: "unavailable",
    reports: "unavailable",
  };
  try {
    discord = await store.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`SELECT 1`;
        return yield* discordState(webhooks);
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
  let messaging: "ready" | "unavailable" = "ready";
  const messagingStarted = performance.now();
  try {
    await Effect.runPromise(probeMessaging(configuration.execution, fetcher));
  } catch (cause) {
    messaging = "unavailable";
    const operationId = contactOperationId(cause);
    contactLog({
      requestId,
      operation: "api-app.health",
      stage: "messaging.probe",
      outcome: "failed",
      level: "error",
      durationMs: performance.now() - messagingStarted,
      ...contactCause(cause),
      ...(operationId && { operationId }),
    });
  }
  return healthResponse(
    "api-app",
    database === "ready" &&
      executor.status === "ready" &&
      messaging === "ready" &&
      discord.alerts === "accepting" &&
      discord.reports === "accepting"
      ? "ready"
      : "degraded",
    {
      database,
      storage: "durable-object-sqlite",
      bootstrapOnly: configuration.bootstrapOnly,
      executor,
      messaging,
      discordAlerts: discord.alerts,
      discordReports: discord.reports,
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
    const webhooks = {
      alerts: bindings.DISCORD_ALERT_WEBHOOK_URL,
      reports: bindings.DISCORD_REPORT_WEBHOOK_URL,
    };
    const store = await createApplicationStore(storage, {
      ...configuration.applicationStore,
      webhooks,
      fetcher,
      ...(bindings.ACTIVITY && {
        activity: (request: Request) =>
          bindings.ACTIVITY!.get(bindings.ACTIVITY!.idFromName("ren-ai-activity")).fetch(request),
      }),
      httpClient: Context.get(services, HttpClient.HttpClient),
    });
    let runtime: ReturnType<typeof createExecutionRuntime> | undefined;
    const intake = configuration.execution.managementToken
      ? intakeRequests(store, configuration.execution.managementToken)
      : async () => new Response("Unavailable", { status: 503 });
    const execution = () =>
      (runtime ??= createExecutionRuntime(store, configuration, bindings, groundRules, fetcher));
    return {
      store,
      configuration,
      fetch: (incoming) =>
        applicationRequest(incoming, async (request) => {
          const path = new URL(request.url).pathname;
          if (path === "/health" && request.method === "GET")
            return health(request, store, configuration, fetcher, webhooks);
          if (path.startsWith("/management/state/"))
            return stateTransfer(
              request,
              store,
              configuration.applicationStore.managementToken,
              configuration.bootstrapOnly,
            );
          if (configuration.bootstrapOnly && isWriteRequest(request)) return bootstrapResponse();
          if (path === "/management/intake/watch" || path === "/management/intake/wake")
            return intake(request);
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
      tick: async (requestId?: string) => {
        if (configuration.bootstrapOnly) return;
        const metrics = store.metricsTick(requestId ?? crypto.randomUUID());
        const current = execution();
        try {
          const results = await Promise.allSettled([
            metrics,
            current.then((executionRuntime) => executionRuntime.tick(requestId)),
          ]);
          for (const result of results) if (result.status === "rejected") throw result.reason;
        } catch (cause) {
          const initialized = await current.then(
            (value) => value.initialized,
            () => false,
          );
          // Retrying startup may discard its partial scope. A failed heartbeat must
          // not dispose the RPC server underneath unrelated, in-flight tool calls.
          if (!initialized && runtime === current) {
            runtime = undefined;
            await current.then((value) => value.close()).catch(() => {});
          }
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
