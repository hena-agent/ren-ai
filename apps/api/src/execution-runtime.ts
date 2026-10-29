import { Clock, Context, Effect, Exit, Layer, Scope } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { remoteMessages } from "@ren-ai/imsg/client";
import { startMessagingApplication } from "./application.ts";
import { applicationGateway } from "./opencode/application-gateway.ts";
import { remoteHost } from "./opencode/remote.ts";
import { syncFolders, catalogRefresher } from "./opencode/catalog-sync.ts";
import { catalogClient } from "./personas/catalog.ts";
import { firstContacts } from "./discovery/first-contact.ts";
import { operatorHandler } from "./operator/api.ts";
import { applicationAlerts } from "./alerts.ts";
import type { ApplicationStore } from "./application-store.ts";
import type { CloudflareBindings, CloudflareConfiguration } from "./cloudflare-config.ts";
import { SqlClient } from "effect/sql";
import { createHash, timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import { contactCause, contactLog } from "./discovery/diagnostics.ts";
import { conversationLanguages } from "./discovery/conversation-languages.ts";
import { sessionFolders } from "@ren-ai/plugin-session-folder/protocol";
import { runtimeStatus, runtimeStatusRequest } from "./conversations/runtime-status.ts";
import { conversationMessagesRequest } from "./conversations/http.ts";
import { conversationImageRequest } from "./conversations/preview.ts";
import { prepareMessaging } from "./application-tools.ts";
import type { Persona } from "@ren-ai/personas";
import { cachedCatalog } from "./personas/cached-catalog.ts";
import { scheduleWork } from "./scheduling.ts";
import { usageCollector } from "./usage/collect.ts";
import { waitlistNotifications } from "./discovery/notifications.ts";
import { runWorkLanes, maintenanceWork, withWorkBudget, workBatchSize } from "./work-budget.ts";
import { reloadPublicCatalog } from "./personas/public-catalog.ts";
import { conversationPhotos } from "./photos/photos.ts";
import { conversations } from "./conversations/conversations.ts";
import { recheckRequest } from "./discovery/recheck.ts";

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
  const health = await run(applicationAlerts);
  const catalog = catalogClient(
    { url: bindings.PERSONA_CATALOG_URL, token: bindings.TOKEN_CATALOG },
    fetcher,
  );
  const notifications = await run(waitlistNotifications(messages, contactLog, catalog.publicList));
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
    const directory = yield* conversations;
    const photos = bindings.CONVERSATION_PHOTOS
      ? yield* conversationPhotos({
          personas,
          sheet: catalog.sheet,
          bucket: bindings.CONVERSATION_PHOTOS,
          key: bindings.CODEX_IMAGE_API_KEY ?? "",
          active: directory.active,
          fetcher,
        })
      : undefined;
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
      photos,
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
      tick: runWorkLanes("execution.cursor", [
        { name: "intake", run: host.heartbeat.intake },
        { name: "contacts", run: contacts.tick },
        { name: "followUps", run: host.heartbeat.followUps },
        { name: "recovery", run: maintenanceWork("recovery", host.heartbeat.failedTurns) },
        {
          name: "turns",
          run: Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const now = yield* Clock.currentTimeMillis;
            const limit = yield* workBatchSize;
            const due = yield* sql<{
              name: string;
              generation: number;
            }>`SELECT name, generation FROM application_work
            WHERE name LIKE 'turn:%' AND due <= ${now} ORDER BY due, name LIMIT ${limit}`;
            const failed = yield* sql<{
              sessionID: string;
            }>`SELECT session_id AS sessionID FROM failed_turn
            WHERE review = 0 AND retry_at <= ${now} ORDER BY retry_at, session_id LIMIT ${limit}`;
            const ids = [
              ...new Set([
                ...due.map((row) => row.name.slice(5)),
                ...failed.map((row) => row.sessionID),
              ]),
            ];
            if (ids.length) yield* host.heartbeat.checkTurns(ids);
            for (const row of due)
              yield* sql`DELETE FROM application_work WHERE name = ${row.name} AND generation = ${row.generation}
                AND NOT EXISTS (SELECT 1 FROM conversation c JOIN user u ON u.id = c.user_id WHERE c.session_id = SUBSTR(application_work.name, 6)
                  AND c.ended_at IS NULL AND NOT EXISTS (SELECT 1 FROM blocked WHERE handle = u.handle))`;
          }),
        },
        { name: "rebuilds", run: host.heartbeat.rebuilds },
        { name: "usage", run: Effect.suspend(() => usage.tick) },
        { name: "stopped", run: host.heartbeat.stopped },
        { name: "endings", run: host.heartbeat.endings },
        { name: "photos", run: photos ? photos.cleanup().pipe(Effect.asVoid) : Effect.void },
        {
          name: "catalog",
          run: maintenanceWork("catalog.recovery", catalogSync.reconcile(groundRules)),
        },
      ]),
    };
  });
  let ready: Promise<Effect.Success<typeof boot>> | undefined;
  let initialized = false;
  const open = (correlation?: string) => {
    if (ready) return ready;
    const requestId = correlation ?? randomUUID();
    const attemptScope = Scope.forkUnsafe(scope);
    ready = run(
      withWorkBudget(boot, requestId).pipe(
        Effect.provideService(Scope.Scope, attemptScope),
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? Scope.close(attemptScope, exit) : Effect.void,
        ),
      ),
    )
      .then((runtime) => {
        initialized = true;
        return runtime;
      })
      .catch((cause) => {
        ready = undefined;
        callback = undefined;
        throw cause;
      });
    return ready;
  };
  const refreshCatalog = async (request: Request) => {
    if (request.method !== "POST")
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const start = performance.now();
    const requestId = randomUUID();
    const fields = { requestId, operation: "catalog.refresh", stage: "catalog.sync" };
    try {
      await run(reloadPublicCatalog);
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
  };
  return {
    get initialized() {
      return initialized;
    },
    tick: async (requestId: string = randomUUID()) => {
      await run(
        withWorkBudget(
          runWorkLanes("alarm.cursor", [
            { name: "notifications", run: notifications.tick },
            {
              name: "execution",
              run: Effect.tryPromise({
                try: () => open(requestId),
                catch: (cause) =>
                  cause instanceof Error ? cause : new Error("Execution startup unavailable"),
              }).pipe(Effect.flatMap((runtime) => runtime.tick)),
            },
          ]),
          requestId,
        ),
      );
    },
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/rpc")) {
        if (callback) {
          const response = await callback.handler(request);
          return new Response(await response.arrayBuffer(), response);
        }
        const started = performance.now();
        const requestId = randomUUID();
        void open(requestId).catch((cause) =>
          contactLog({
            requestId,
            operation: "api-app.execution",
            stage: "execution.startup",
            outcome: "failed",
            level: "error",
            durationMs: performance.now() - started,
            ...contactCause(cause),
          }),
        );
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
      if (url.pathname === "/operator/imessage-recheck")
        return recheckRequest(request, messages, run);
      if (url.pathname === "/operator/messages")
        return conversationMessagesRequest(request, messages, run);
      if (url.pathname === "/operator/message-image")
        return conversationImageRequest(request, messages, run);
      if (url.pathname === "/management/catalog/refresh") return refreshCatalog(request);
      const runtime = await open();
      if (url.pathname === "/operator/languages" && request.method === "GET")
        return run(runtime.languages(request));
      url.pathname = url.pathname.slice("/operator".length);
      return operator!.handler(new Request(url, request));
    },
    close: () => Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))),
  };
}
