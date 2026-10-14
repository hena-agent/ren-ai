import { join } from "node:path";
import { ConfigProvider, Context, Effect } from "effect";
import { HttpClient } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { Session } from "@opencode/schema/session";
import { makeHealth } from "./health/health.ts";
import { makeBackup } from "./backup/backup.ts";
import { startMessagingApplication } from "./application.ts";
import { prepareMessaging, type MessagingTools } from "./application-tools.ts";
import { catalogClient, type CatalogConnection } from "./personas/catalog.ts";
import { operatorHandler } from "./operator/api.ts";
import { serveOperatorSocket } from "./operator/socket.ts";
import { servePublic } from "@ren-ai/transport/listener";
import { remoteMessages } from "@ren-ai/imsg/client";
import { applicationGateway } from "./opencode/application-gateway.ts";
import { remoteHost, type RemoteConfig } from "./opencode/remote.ts";
import { exportSessions } from "./opencode/transfer.ts";
import { syncFolders, catalogRefresher } from "./opencode/catalog-sync.ts";
import { makeDiscoveryWeb } from "./discovery/discovery.ts";
import { contacts } from "./discovery/contacts.ts";
import { checkAssignments } from "./discovery/assignment.ts";
import { contactManagement } from "./discovery/management.ts";
import { firstContacts } from "./discovery/first-contact.ts";
import { migrate } from "./database.ts";

export interface ServerConfig {
  readonly stateDirectory: string;
  readonly catalog: CatalogConnection;
  readonly managementToken: string;
  readonly publicPort: number;
  readonly hostname?: string;
  readonly bootstrapOnly?: boolean;
  readonly messaging: { readonly url: string; readonly token: string };
  readonly opencode: RemoteConfig;
  readonly secrets: Readonly<
    Record<"TURNSTILE_SECRET" | "APPLICATION_TOKEN" | "DISCORD_WEBHOOK_URL", string>
  >;
}

const starting = () => Promise.resolve(new Response("Starting", { status: 503 }));
const notFound = () => Promise.resolve(new Response("Not Found", { status: 404 }));

/** Start the callback listener before recovery can load the remote persona plugin. */
export const composeServer = (config: ServerConfig) =>
  Effect.gen(function* () {
    const health = yield* makeHealth.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config.secrets))),
    );
    const client = yield* HttpClient.HttpClient;
    const sql = yield* SqlClient.SqlClient;
    yield* migrate;
    const messages = yield* remoteMessages(config.messaging);
    const catalog = catalogClient(config.catalog);
    const { personas } = yield* Effect.tryPromise(catalog.load);
    yield* checkAssignments;
    const discovery = yield* makeDiscoveryWeb({
      catalog: catalog.publicList,
      image: catalog.publicImage,
      turnstileSecret: config.secrets.TURNSTILE_SECRET,
    });
    yield* Effect.addFinalizer(() => Effect.promise(discovery.dispose));
    let callbackWeb: (request: Request) => Promise<Response> = starting;
    let managementWeb: (request: Request) => Promise<Response> = starting;
    const publicWeb = (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/rpc")) return callbackWeb(request);
      if (path.startsWith("/management/")) return managementWeb(request);
      if (path.startsWith("/discovery/"))
        return discovery.handler(request, Context.make(HttpClient.HttpClient, client));
      return notFound();
    };
    const listener = yield* servePublic(publicWeb, config.publicPort, config.hostname);
    const registerCallback = (tools: MessagingTools, actionsEnabled: boolean) =>
      Effect.gen(function* () {
        const callback = applicationGateway(
          tools,
          health,
          config.secrets.APPLICATION_TOKEN,
          actionsEnabled,
        );
        callbackWeb = callback.handler;
        yield* Effect.addFinalizer(() => Effect.promise(callback.dispose));
      });
    if (config.bootstrapOnly) {
      const prepared = yield* prepareMessaging(personas, messages, messages.gestures);
      yield* registerCallback(prepared.tools, false);
      return { mode: "bootstrap" as const, publicWeb, listener };
    }
    const host = yield* startMessagingApplication(
      personas,
      (tools) =>
        Effect.gen(function* () {
          yield* registerCallback(tools, true);
          const runtime = yield* remoteHost(config.opencode, personas);
          yield* syncFolders(
            runtime.client,
            config.opencode.directory,
            personas,
            config.opencode.groundRules,
          );
          return runtime;
        }),
      messages,
      messages.gestures,
      health,
    );
    const refresh = catalogRefresher(
      host.client,
      config.opencode.directory,
      catalog.load,
      personas,
    );
    managementWeb = contactManagement(yield* contacts(catalog.publicList), config.managementToken);
    const scheduled = yield* firstContacts(
      host,
      messages,
      host.conversations,
      config.opencode.model,
    );
    const heartbeat = Effect.all([
      refresh.refresh(config.opencode.groundRules),
      host.heartbeat.intake,
      host.heartbeat.followUps,
      host.heartbeat.failedTurns,
      scheduled.tick,
    ]).pipe(
      Effect.asVoid,
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError((cause) => new Error("Application heartbeat failed", { cause })),
    );
    yield* heartbeat;
    yield* Effect.forkScoped(health.monitor);
    const backup = yield* makeBackup(
      {
        directory: join(config.stateDirectory, "backups"),
        sessions: sql<{ sessionID: string }>`SELECT session_id AS sessionID FROM conversation
      UNION SELECT session_id AS sessionID FROM retained_session`.pipe(
          Effect.flatMap((rows) =>
            exportSessions(
              host.client,
              rows.map((row) => Session.ID.make(row.sessionID)),
            ),
          ),
        ),
      },
      health,
    );
    yield* Effect.forkScoped(backup.monitor);
    const operator = operatorHandler(host.operator);
    yield* Effect.addFinalizer(() => Effect.promise(operator.dispose));
    const socket = join(config.stateDirectory, "operator", "operator.sock");
    const stop = yield* Effect.promise(() => serveOperatorSocket(socket, operator.handler));
    yield* Effect.addFinalizer(() => Effect.promise(stop));
    return { mode: "running" as const, host, heartbeat, backup, socket, publicWeb, listener };
  });
