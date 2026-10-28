import { SqliteClient } from "@effect/sql-sqlite-do";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { HttpClient } from "effect/http";
import { SqlClient } from "effect/sql";
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { migrate } from "./database.ts";
import { contacts } from "./discovery/contacts.ts";
import { contactManagement } from "./discovery/management.ts";
import { makeDiscoveryWeb } from "./discovery/discovery.ts";
import type { PublicPersona } from "@ren-ai/onboarding";
import { authorize } from "@ren-ai/transport/server";
import { conversationStatus } from "./conversations/status.ts";
import { conversationRecords, requestOperatorEnding } from "./conversations/http.ts";
import { usageQueries } from "./usage/query.ts";
import { loadMetrics, metricsHandler } from "./metrics/query.ts";
import { configureDiscord, type Webhooks } from "./metrics/discord.ts";
import { metricsTasks } from "./metrics/tasks.ts";
import { runWorkLanes, withWorkBudget, WorkLaneFailure } from "./work-budget.ts";

export interface ApplicationStoreConfig {
  readonly catalog: () => Promise<readonly PublicPersona[]>;
  readonly turnstileSecret: string;
  readonly managementToken: string;
  readonly httpClient: HttpClient.HttpClient;
  readonly activity?: (request: Request) => Promise<Response>;
  readonly webhooks?: Webhooks;
  readonly fetcher?: typeof fetch;
}

export interface ApplicationStore {
  readonly metricsTick: (requestId: string) => Promise<void>;
  /** Bounded alarm work that replaces Discovery's served public snapshot. */
  readonly catalogTick: (requestId: string) => Promise<void>;
  readonly context: Context.Context<SqlClient.SqlClient>;
  readonly run: <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => Promise<A>;
  readonly handler: (request: Request) => Promise<Response>;
  readonly close: () => Promise<void>;
}

/**
 * Opens one scoped SQLite client for this Durable Object instance. All public
 * registration and operator admission requests use that same SQL context.
 */
export const createApplicationStore = async (
  storage: DurableObjectStorage,
  config: ApplicationStoreConfig,
): Promise<ApplicationStore> => {
  const scope = await Effect.runPromise(Scope.make());
  const context = await Effect.runPromise(
    Layer.buildWithScope(SqliteClient.layer({ storage }), scope),
  );
  const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.runPromise(Effect.provideContext(effect, context));
  try {
    await run(migrate);
    const contactsStore = await run(contacts(config.catalog));
    const discovery = await run(
      makeDiscoveryWeb({
        catalog: config.catalog,
        turnstileSecret: config.turnstileSecret,
      }),
    );
    const management = contactManagement(contactsStore, config.managementToken);
    const webhooks = config.webhooks ?? { alerts: undefined, reports: undefined };
    await run(configureDiscord(webhooks));
    const metrics = metricsHandler(run, config.managementToken, webhooks, config.activity);
    const statusStore = await run(conversationStatus(config.catalog));
    const usage = await run(usageQueries);
    const records = conversationRecords(statusStore, (effect) => Effect.runPromise(effect), usage);
    const privateRecords = config.managementToken
      ? authorize(
          (request) =>
            request.method === "POST" ? requestOperatorEnding(request, run) : records(request),
          config.managementToken,
        )
      : async () => new Response("Unauthorized", { status: 401 });
    const httpContext = Context.make(HttpClient.HttpClient, config.httpClient);
    return {
      context,
      run,
      catalogTick: (requestId) =>
        run(
          withWorkBudget(
            runWorkLanes("catalog.cursor", [
              { name: "refresh", run: discovery.maintainCatalog },
            ]).pipe(
              // This store lane owns its diagnostic and retry; it must not mask execution failures.
              Effect.catchIf(
                (cause) => cause instanceof WorkLaneFailure,
                () => Effect.void,
              ),
            ),
            requestId,
          ),
        ),
      metricsTick: (requestId) =>
        run(
          metricsTasks(
            (query) => loadMetrics(query, run, webhooks, config.activity),
            webhooks,
            config.fetcher ?? fetch,
            requestId,
          ),
        ),
      handler: (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/management/metrics") return metrics(request);
        if (path.startsWith("/discovery/")) return discovery.handler(request, httpContext);
        if (path.startsWith("/management/conversations")) return privateRecords(request);
        if (path.startsWith("/management/")) return management(request);
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      },
      close: async () => {
        await discovery.dispose();
        await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
      },
    };
  } catch (cause) {
    await Effect.runPromise(Scope.close(scope, Exit.fail(cause)));
    throw cause;
  }
};
