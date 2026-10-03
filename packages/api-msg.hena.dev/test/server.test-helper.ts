import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { TestLLM } from "@opencode/ai/testing";
import type { Session } from "@opencode/core/session";
import { ConfigProvider, Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { startPersonaHost } from "./application.test-helper.ts";
import { composeServer } from "../src/server.ts";
import { applicationConfig } from "../src/configuration.ts";
import { servePublic } from "../src/public-listener.ts";
import { messageGateway } from "../src/gateway/server.ts";
import { installedPlugins, remotePersonaPlugins } from "./persona-plugins.test-helper.ts";
import { silentAlerts } from "./messaging.test-helper.ts";
import { scriptedOverrides } from "./host.test-helper.ts";
import type { Messages } from "../src/messages/messages.ts";
import type { Gestures } from "../src/gestures/gestures.ts";
import { AbsolutePath, Agent, Model } from "@opencode/schema";
import { remoteHost } from "../src/opencode/remote.ts";
import type { standaloneTestHost } from "./messaging-host.test-helper.ts";
import { listenerUrl } from "./listener.test-helper.ts";

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
    const config = yield* applicationConfig.pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            STATE_DIRECTORY: root,
            PERSONA_DIRECTORY: personaDirectory,
            DEFAULT_PERSONA_ID: "persona1",
            PORT: "0",
            IMSG_URL: `${listenerUrl(mac)}/rpc`,
            IMSG_TOKEN: "messaging-secret",
            OPENCODE_URL: listenerUrl(openCode),
            OPENCODE_AUTHORIZATION: "Basic machine",
            OPENCODE_DIRECTORY: personaDirectory,
            TURNSTILE_SECRET: "turnstile-test",
            REN_AI_APPLICATION_TOKEN: "application-secret",
            DISCORD_WEBHOOK_URL: "https://discord.invalid/hook",
            ...(model ? { PERSONA_MODEL: model } : {}),
          }),
        ),
      ),
    );
    const server = yield* composeServer({
      ...config,
      ...(model ? { noticeVersion: "v1" } : {}),
    });
    if (server.mode !== "running") throw new Error("Expected running application");
    const tokenFile = join(root, "application-token");
    yield* Effect.promise(() => writeFile(tokenFile, "\napplication-secret\n", { mode: 0o600 }));
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
                  tokenFile,
                },
              }),
          }),
        ),
      ),
    );
    return server;
  });
