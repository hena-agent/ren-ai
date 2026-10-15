import { join } from "node:path";
import { loadGroundRules } from "@ren-ai/plugin-session-folder/files";
import { vi } from "vitest";
import type { TestLLM } from "@opencode/ai/testing";
import type { Session } from "@opencode/core/session";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { startPersonaHost } from "./application.test-helper.ts";
import { composeServer } from "./composition.test-helper.ts";
import { servePublic } from "@ren-ai/transport/listener";
import { messageGateway } from "@ren-ai/imsg/testing";
import { installedPlugins, remotePersonaPlugins } from "./persona-plugins.test-helper.ts";
import { silentAlerts } from "./messaging.test-helper.ts";
import { scriptedOverrides } from "./host.test-helper.ts";
import type { Messages, Gestures } from "@ren-ai/imsg";
import { AbsolutePath, Agent, Model } from "@opencode/schema";
import { remoteHost } from "../src/opencode/remote.ts";
import type { standaloneTestHost } from "./messaging-host.test-helper.ts";
import { listenerUrl } from "./listener.test-helper.ts";
import { testCatalog } from "./catalog.test-helper.ts";

export const localOpenCode = (
  native: Effect.Success<ReturnType<typeof standaloneTestHost>>,
  directory: string,
) =>
  remoteHost(
    {
      baseUrl: "https://oc.test",
      authorization: "Basic test",
      directory,
      model: "test/probe",
      groundRules: "",
    },
    native.personas,
  ).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
      native.web(new Request(input, init)),
    ),
  );

export const registerApplicationPlugin = (
  native: Effect.Success<ReturnType<typeof standaloneTestHost>>,
  plugins: ReturnType<typeof remotePersonaPlugins>,
  network: typeof fetch,
) =>
  Effect.forEach(plugins, (plugin) =>
    Effect.promise(() =>
      native.run(
        native.plugins.register({
          ...plugin,
          effect: (ctx) =>
            plugin.effect(ctx).pipe(Effect.provideService(FetchHttpClient.Fetch, network)),
        }),
      ),
    ),
  );

export const allowAllSessionTools = (
  remote: Effect.Success<ReturnType<typeof remoteHost>>,
  sessionID: Session.ID,
) =>
  remote.client.session.update({
    sessionID,
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
  });

export const unrelatedSession = (
  client: Effect.Success<ReturnType<typeof remoteHost>>["client"],
  directory: string,
) =>
  Effect.gen(function* () {
    const session = yield* client.session.create({
      agent: Agent.ID.make("build"),
      model: Model.Ref.parse("test/probe"),
      location: { directory: AbsolutePath.make(directory) },
      permissions: [{ action: "*", resource: "*", effect: "deny" }],
    });
    yield* client.session.prompt({
      sessionID: session.id,
      text: "unrelated project",
    });
    yield* client.session.wait({ sessionID: session.id });
    return yield* client.session.get({ sessionID: session.id });
  });

export const composedTestServer = (
  root: string,
  personaDirectory: string,
  llm: TestLLM.TestInterface,
  messages: Messages,
  gestures: Gestures,
  model?: string,
) =>
  Effect.gen(function* () {
    const native = yield* startPersonaHost(join(root, "isolated"), {
      configDirectory: join(root, "config"),
      databasePath: ":memory:",
      personaDirectory,
      providers: {},
      model: "test/probe",
      handleForSession: () => Effect.succeed(undefined),
      health: silentAlerts,
      overrides: scriptedOverrides(llm),
    });
    const openCode = yield* servePublic(native.web, 0);
    const gateway = messageGateway(messages, "messaging-secret", gestures);
    yield* Effect.addFinalizer(() => Effect.promise(gateway.dispose));
    const mac = yield* servePublic(gateway.handler, 0);
    const catalog = yield* testCatalog(personaDirectory);
    const server = yield* composeServer({
      catalog,
      managementToken: "management-test-token",
      publicPort: 0,
      messaging: { url: `${listenerUrl(mac)}/rpc`, token: "messaging-secret" },
      opencode: {
        baseUrl: listenerUrl(openCode),
        authorization: "Basic machine",
        directory: personaDirectory,
        model: model ?? "opencode-go/deepseek-v4.1-flash",
        groundRules: yield* Effect.tryPromise(loadGroundRules),
      },
      secrets: {
        TURNSTILE_SECRET: "turnstile-test",
        APPLICATION_TOKEN: "application-secret",
        DISCORD_WEBHOOK_URL: "https://discord.invalid/hook",
      },
    });
    if (server.mode !== "running") throw new Error("Expected running application");
    const stop = yield* messages.follow(0, () => server.heartbeat);
    yield* Effect.addFinalizer(() => Effect.sync(stop));
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.sleep("1 second").pipe(
          Effect.andThen(server.heartbeat),
          Effect.catchCause(Effect.logError),
        ),
      ),
    );
    const previousToken = process.env["TOKEN_MANAGEMENT"];
    vi.stubEnv("TOKEN_MANAGEMENT", "application-secret");
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => vi.stubEnv("TOKEN_MANAGEMENT", previousToken)),
    );
    yield* Effect.forEach(installedPlugins, (installedPlugin) =>
      Effect.promise(() =>
        native.run(
          native.plugins.register({
            ...installedPlugin,
            effect: (ctx) =>
              installedPlugin.effect({
                ...ctx,
                options: {
                  url: `${listenerUrl(server.listener)}/rpc`,
                  directory: personaDirectory,
                },
              }),
          }),
        ),
      ),
    );
    return server;
  });
