import { Context, Effect, Exit, Layer, Scope } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { remoteMessages } from "@ren-ai/imsg/client";
import { startMessagingApplication } from "./application.ts";
import { applicationGateway } from "./opencode/application-gateway.ts";
import { remoteHost } from "./opencode/remote.ts";
import { catalogRefresher, syncFolders } from "./opencode/catalog-sync.ts";
import { catalogClient } from "./personas/catalog.ts";
import { firstContacts } from "./discovery/first-contact.ts";
import { operatorHandler } from "./operator/api.ts";
import { createExecutionHealth } from "./execution-health.ts";
import type { ApplicationStore } from "./application-store.ts";
import type { CloudflareBindings, CloudflareConfiguration } from "./cloudflare-config.ts";
import type { SqlClient } from "effect/unstable/sql";
import { createHash, timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import { contactCause, contactLog } from "./discovery/diagnostics.ts";

type RuntimeServices = SqlClient.SqlClient | HttpClient.HttpClient | Scope.Scope;
const digest = (value: string) => createHash("sha256").update(value).digest();

export async function createExecutionRuntime(
  store: ApplicationStore,
  configuration: CloudflareConfiguration,
  bindings: CloudflareBindings,
  groundRules: string,
  fetcher: typeof fetch,
) {
  if (!configuration.execution.managementToken || !bindings.TOKEN_CATALOG?.trim())
    throw new Error("TOKEN_MANAGEMENT and TOKEN_CATALOG are required for execution");
  const scope = await Effect.runPromise(Scope.make());
  const http = await Effect.runPromise(
    Layer.buildWithScope(FetchHttpClient.layer, scope).pipe(
      Effect.provideService(FetchHttpClient.Fetch, fetcher),
    ),
  );
  const services = Context.add(Context.merge(store.context, http), Scope.Scope, scope);
  const run = <A, E>(effect: Effect.Effect<A, E, RuntimeServices>) =>
    Effect.runPromise(Effect.provideContext(effect, services));
  const execution = configuration.execution;
  const catalog = catalogClient(
    { url: bindings.PERSONA_CATALOG_URL, token: bindings.TOKEN_CATALOG },
    fetcher,
  );
  let callback: ReturnType<typeof applicationGateway> | undefined;
  let operator: ReturnType<typeof operatorHandler> | undefined;
  const boot = Effect.gen(function* () {
    const { personas } = yield* Effect.tryPromise(catalog.load);
    const httpClient = yield* HttpClient.HttpClient;
    const messages = yield* remoteMessages({
      url: execution.imsgRpcUrl,
      token: execution.managementToken,
    }).pipe(
      // RPC's HTTP transport appends '/'; the executor exposes one exact endpoint.
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.makeWith(
          (request) =>
            httpClient.postprocess(
              Effect.map(request, HttpClientRequest.setUrl(execution.imsgRpcUrl)),
            ),
          httpClient.preprocess,
        ),
      ),
    );
    const health = yield* createExecutionHealth(execution, bindings.DISCORD_WEBHOOK_URL, fetcher);
    const host = yield* startMessagingApplication(
      personas,
      (tools) =>
        Effect.gen(function* () {
          callback = applicationGateway(tools, health, execution.managementToken);
          yield* Effect.addFinalizer(() => Effect.promise(callback!.dispose));
          const remote = yield* remoteHost(
            {
              baseUrl: execution.openCodeUrl,
              authorization: `Bearer ${execution.managementToken}`,
              directory: execution.directory,
              model: execution.model,
              groundRules,
            },
            personas,
          );
          yield* syncFolders(remote.client, execution.directory, personas, groundRules);
          return remote;
        }),
      messages,
      messages.gestures,
      health,
    );
    operator = operatorHandler(host.operator);
    yield* Effect.addFinalizer(() => Effect.promise(operator!.dispose));
    const contacts = yield* firstContacts(host, messages, host.conversations, execution.model);
    const catalogSync = catalogRefresher(host.client, execution.directory, catalog.load, personas);
    return {
      refreshCatalog: catalogSync.refresh(groundRules),
      tick: Effect.gen(function* () {
        yield* host.heartbeat.intake;
        yield* contacts.tick;
        yield* host.heartbeat.followUps;
        yield* host.heartbeat.failedTurns;
        yield* health.tick;
      }),
    };
  });
  let ready: Promise<Effect.Success<typeof boot>> | undefined;
  const open = () => {
    if (ready) return ready;
    const started = performance.now();
    const requestId = randomUUID();
    ready = run(boot).catch((cause) => {
      contactLog({
        requestId,
        operation: "api-app.execution",
        stage: "execution.startup",
        outcome: "failed",
        durationMs: performance.now() - started,
        level: "error",
        ...contactCause(cause),
      });
      throw cause;
    });
    return ready;
  };
  return {
    tick: async () => {
      const runtime = await open();
      await run(runtime.tick);
    },
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/rpc")) {
        if (callback) return callback.handler(request);
        // open observes startup failure once; this catch prevents an unhandled detached rejection.
        void open().catch(() => {});
        return new Response("Execution is starting", { status: 503 });
      }
      if (
        !timingSafeEqual(
          digest(request.headers.get("authorization") ?? ""),
          digest(`Bearer ${bindings.TOKEN_MANAGEMENT}`),
        )
      )
        return new Response("Unauthorized", { status: 401 });
      if (url.pathname === "/management/catalog/refresh") {
        if (request.method !== "POST")
          return new Response(null, { status: 405, headers: { Allow: "POST" } });
        const start = performance.now();
        const requestId = randomUUID();
        const fields = { requestId, operation: "catalog.refresh", stage: "catalog.sync" };
        try {
          await run((await open()).refreshCatalog);
          contactLog({
            ...fields,
            outcome: "completed",
            durationMs: performance.now() - start,
            level: "info",
          });
          return new Response(null, { status: 204, headers: { "X-Request-ID": requestId } });
        } catch (cause) {
          contactLog({
            ...fields,
            ...contactCause(cause),
            outcome: "failed",
            durationMs: performance.now() - start,
            level: "error",
          });
          return Response.json(
            { error: "Catalog refresh failed", requestId },
            {
              status: 503,
              headers: { "X-Request-ID": requestId, "Cache-Control": "no-store" },
            },
          );
        }
      }
      await open();
      url.pathname = url.pathname.slice("/operator".length);
      return operator!.handler(new Request(url, request));
    },
    close: () => Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))),
  };
}
