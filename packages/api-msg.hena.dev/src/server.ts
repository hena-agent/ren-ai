import { join } from "node:path";
import { ConfigProvider, Context, Effect } from "effect";
import { HttpClient } from "effect/unstable/http";
import type { HostOptions } from "./opencode/host.ts";
import type { Messages } from "./messages/messages.ts";
import type { Gestures } from "./gestures/gestures.ts";
import { makeHealth } from "./health/health.ts";
import { makeBackup } from "./backup/backup.ts";
import { startMessagingHost } from "./main.ts";
import { noticeCopy } from "./onboarding/onboarding.ts";
import { operatorHandler } from "./operator/api.ts";
import { serveOperatorSocket } from "./operator/socket.ts";
import { serveViewer, viewerFront } from "./opencode/viewer.ts";
import { servePublic } from "./public-listener.ts";

export interface ServerConfig {
  readonly stateDirectory: string;
  readonly personaDirectory: string;
  readonly publicPort: number;
  readonly viewerPort: number;
  readonly noticeVersion?: string;
  readonly secrets: Readonly<
    Record<
      "OPENCODE_GO_KEY" | "TURNSTILE_SECRET" | "VIEWER_PASSWORD" | "DISCORD_WEBHOOK_URL",
      string
    >
  >;
  readonly host?: Partial<Pick<HostOptions, "model" | "providers" | "memory" | "overrides">>;
}

/** The only model choice. DeepSeek V4.1 Flash has a 1M-token context window. */
const productionHost = (key: string) => ({
  model: "opencode-go/deepseek-v4.1-flash#max",
  providers: { "opencode-go": { settings: { apiKey: key } } },
  memory: { contextTokens: 1_000_000, budgetTokens: 600_000, recentTokens: 12_000 },
});

/** Compose once; production injects live adapters, tests inject only Messages and Gestures. */
export const composeServer = (
  config: ServerConfig,
  adapters: {
    readonly messages: (
      health: Effect.Success<typeof makeHealth>,
    ) => Effect.Effect<
      Messages,
      Error,
      | import("effect/unstable/process").ChildProcessSpawner.ChildProcessSpawner
      | import("effect").Scope.Scope
    >;
    readonly gestures: (
      health: Effect.Success<typeof makeHealth>,
    ) => Effect.Effect<
      Gestures,
      Error,
      import("effect/unstable/process").ChildProcessSpawner.ChildProcessSpawner
    >;
  },
) =>
  Effect.gen(function* () {
    const secrets = config.secrets;
    const provider = ConfigProvider.fromUnknown(secrets);
    const health = yield* makeHealth.pipe(Effect.provide(ConfigProvider.layer(provider)));
    const client = yield* HttpClient.HttpClient;
    const messages = yield* adapters.messages(health);
    const gestures = yield* adapters.gestures(health);
    const state = config.stateDirectory;
    const host = yield* startMessagingHost(
      join(state, "isolated"),
      {
        configDirectory: join(state, "isolated", "config"),
        databasePath: join(state, "opencode.sqlite"),
        personaDirectory: config.personaDirectory,
        ...productionHost(secrets.OPENCODE_GO_KEY),
        ...config.host,
        health,
      },
      messages,
      gestures,
      {
        turnstileSecret: secrets.TURNSTILE_SECRET,
        notice: noticeCopy,
        ...(config.noticeVersion ? { noticeVersion: config.noticeVersion } : {}),
      },
      health,
    );
    yield* Effect.addFinalizer(() => Effect.promise(host.disposeOnboarding));
    yield* Effect.forkScoped(health.monitor);
    const backup = yield* makeBackup(
      {
        directory: join(state, "backups"),
        openCodeDatabase: join(state, "opencode.sqlite"),
      },
      health,
    );
    yield* Effect.forkScoped(backup.monitor);
    const operator = operatorHandler(host.operator);
    yield* Effect.addFinalizer(() => Effect.promise(operator.dispose));
    const socket = join(state, "operator", "operator.sock");
    const stop = yield* Effect.promise(() => serveOperatorSocket(socket, operator.handler));
    yield* Effect.addFinalizer(() => Effect.promise(stop));
    const publicWeb = (request: Request) =>
      host.onboardingWeb(request, Context.make(HttpClient.HttpClient, client));
    yield* servePublic(publicWeb, config.publicPort);
    yield* serveViewer(host.web, config.viewerPort).pipe(
      Effect.provide(ConfigProvider.layer(provider)),
    );
    return {
      host,
      backup,
      socket,
      publicWeb,
      viewerWeb: viewerFront(host.web, secrets.VIEWER_PASSWORD),
    };
  });
