import { Clock, Context, Effect, Exit, Layer, Scope } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { remoteMessages } from "@ren-ai/imsg/client";
import { startMessagingApplication } from "./application.ts";
import { applicationGateway } from "./opencode/application-gateway.ts";
import { remoteHost } from "./opencode/remote.ts";
import { syncFolders, catalogRefresher } from "./opencode/catalog-sync.ts";
import { catalogClient } from "./personas/catalog.ts";
import { firstContacts } from "./discovery/first-contact.ts";
import { operatorHandler } from "./operator/api.ts";
import { createExecutionHealth } from "./execution-health.ts";
import type { ApplicationStore } from "./application-store.ts";
import type { CloudflareBindings, CloudflareConfiguration } from "./cloudflare-config.ts";
import { SqlClient } from "effect/unstable/sql";
import { createHash, timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import { contactCause, contactLog } from "./discovery/diagnostics.ts";
import { conversationLanguages } from "./discovery/conversation-languages.ts";
import { sessionFolders } from "@ren-ai/plugin-session-folder/protocol";
import { runtimeStatus, runtimeStatusRequest } from "./conversations/runtime-status.ts";
import { prepareMessaging } from "./application-tools.ts";
import type { Persona } from "@ren-ai/personas";
import { cachedCatalog } from "./personas/cached-catalog.ts";
import { scheduleWork, safetyInterval } from "./scheduling.ts";
import { usageCollector } from "./usage/collect.ts";
import { waitlistNotifications } from "./discovery/notifications.ts";

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
  const messages = await run(
    remoteMessages({ url: execution.imsgRpcUrl, token: execution.managementToken }),
  );
  const notifications = await run(waitlistNotifications(messages));
  const health = await run(createExecutionHealth(execution, bindings.DISCORD_WEBHOOK_URL, fetcher));
  const catalog = catalogClient(
    { url: bindings.PERSONA_CATALOG_URL, token: bindings.TOKEN_CATALOG },
    fetcher,
  );
  let callback: ReturnType<typeof applicationGateway> | undefined;
  let operator: ReturnType<typeof operatorHandler> | undefined;
  const remoteConfiguration = {
    baseUrl: execution.openCodeUrl,
    authorization: `Bearer ${execution.managementToken}`,
    directory: execution.directory,
    model: execution.model,
    groundRules,
    onPrompt: (sessionID: string) =>
      scheduleWork(`turn:${sessionID}`, Date.now() + 30_000).pipe(Effect.provideContext(services)),
  };
  let inspector: Promise<ReturnType<typeof runtimeStatusRequest>> | undefined;
  const inspect = () =>
    (inspector ??= run(
      Effect.gen(function* () {
        // Inspect metadata without starting intake, synchronizing folders or resuming model work.
        const personas = new Map<string, Persona>();
        const remote = yield* remoteHost(remoteConfiguration, personas);
        const { endings } = yield* prepareMessaging(personas, messages, messages.gestures);
        const status = yield* runtimeStatus(
          remote,
          (id) =>
            remote.client.session.active().pipe(
              Effect.map((states) => Boolean(states[id])),
              Effect.mapError(
                (cause) => new Error("OpenCode active sessions unavailable", { cause }),
              ),
            ),
          endings,
        );
        return runtimeStatusRequest(status, (effect) => Effect.runPromise(effect));
      }),
    ).catch((cause) => {
      inspector = undefined;
      throw cause;
    }));
  const boot = Effect.gen(function* () {
    let usage: Effect.Success<ReturnType<typeof usageCollector>>;
    const saved = yield* cachedCatalog(catalog.load, groundRules);
    const snapshot = yield* saved.current;
    const { personas } = snapshot;
    const host = yield* startMessagingApplication(
      personas,
      (tools) =>
        Effect.gen(function* () {
          callback = applicationGateway(tools, health, execution.managementToken);
          yield* Effect.addFinalizer(() => Effect.promise(callback!.dispose));
          const remote = yield* remoteHost(remoteConfiguration, personas);
          yield* saved.synchronize(
            snapshot,
            syncFolders(remote.client, execution.directory, personas, groundRules),
          );
          usage = yield* usageCollector({
            messages: (input) =>
              remote.client.message
                .list(input)
                .pipe(
                  Effect.mapError(
                    (cause) => new Error("OpenCode usage history unavailable", { cause }),
                  ),
                ),
            get: (id) => remote.sessions.get(id),
          });
          return {
            ...remote,
            sessions: {
              ...remote.sessions,
              remove: (sessionID: Parameters<typeof remote.sessions.remove>[0]) =>
                usage.session(sessionID).pipe(Effect.andThen(remote.sessions.remove(sessionID))),
            },
          };
        }),
      messages,
      messages.gestures,
      health,
      false,
    );
    operator = operatorHandler(host.operator);
    yield* Effect.addFinalizer(() => Effect.promise(operator!.dispose));
    const contacts = yield* firstContacts(host, messages, host.conversations, execution.model);
    const catalogSync = catalogRefresher(host.client, execution.directory, catalog.load, personas);
    return {
      refreshCatalog: catalogSync.refresh(groundRules),
      languages: conversationLanguages((sessionID) =>
        host.client
          .rpc(sessionFolders)
          .read({ folderID: sessionID }, { location: { directory: execution.directory } })
          .pipe(
            Effect.mapError(
              (cause) => new Error("Conversation State could not be read", { cause }),
            ),
          ),
      ),
      tick: Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const now = yield* Clock.currentTimeMillis;
        yield* host.heartbeat.intake;
        yield* contacts.tick;
        yield* host.heartbeat.followUps;
        const [last] = yield* sql<{
          at: number;
        }>`SELECT at FROM application_clock WHERE name = 'recovery'`;
        if (!last || last.at + safetyInterval <= now) {
          yield* host.heartbeat.failedTurns;
          yield* sql`INSERT INTO application_clock (name, at) VALUES ('recovery', ${now}) ON CONFLICT(name) DO UPDATE SET at = excluded.at`;
        }
        const due = yield* sql<{
          sessionID: string;
        }>`SELECT SUBSTR(name, 6) AS sessionID FROM application_work WHERE name LIKE 'turn:%' AND due <= ${now}
            UNION SELECT session_id AS sessionID FROM failed_turn WHERE review = 0 AND retry_at <= ${now}`;
        if (due.length) yield* host.heartbeat.checkTurns(due.map((row) => row.sessionID));
        yield* host.heartbeat.rebuilds;
        yield* usage.tick;
        yield* Effect.all([host.heartbeat.stopped, host.heartbeat.endings], {
          concurrency: "unbounded",
        });
        if (!last || last.at + safetyInterval <= now) yield* catalogSync.reconcile(groundRules);
      }),
    };
  });
  let ready: Promise<Effect.Success<typeof boot>> | undefined;
  let initialized = false;
  const open = () => {
    if (ready) return ready;
    const started = performance.now();
    const requestId = randomUUID();
    ready = run(boot)
      .then((runtime) => {
        initialized = true;
        return runtime;
      })
      .catch((cause) => {
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
    get initialized() {
      return initialized;
    },
    tick: async () => {
      const results = await Promise.allSettled([
        run(notifications.tick),
        (async () => {
          await run(health.tick);
          const runtime = await open();
          await run(runtime.tick);
        })(),
      ]);
      for (const result of results) if (result.status === "rejected") throw result.reason;
    },
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/rpc")) {
        if (callback) {
          const response = await callback.handler(request);
          return new Response(await response.arrayBuffer(), response);
        }
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
      if (url.pathname === "/operator/conversations") return (await inspect())(request);
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
      const runtime = await open();
      if (url.pathname === "/operator/languages" && request.method === "GET")
        return run(runtime.languages(request));
      url.pathname = url.pathname.slice("/operator".length);
      return operator!.handler(new Request(url, request));
    },
    close: () => Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))),
  };
}
