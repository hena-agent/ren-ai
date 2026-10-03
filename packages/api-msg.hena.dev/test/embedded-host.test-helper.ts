import { SdkPlugins } from "@opencode/core/plugin/sdk";
import { Session } from "@opencode/core/session";
import { Bus } from "@opencode/core/bus";
import { createEmbeddedRoutes } from "@opencode/server/routes";
import { AbsolutePath, Agent, Location, Model } from "@opencode/schema";
import { SessionEvent } from "@opencode/schema/session-event";
import { Context, Effect, Layer, ManagedRuntime, Scope } from "effect";
import { HttpEffect, HttpRouter, HttpServer, HttpServerRequest } from "effect/unstable/http";
import { sessionFolderPlugin } from "@ren-ai/plugin-session-folder";
import { folderFiles, loadGroundRules, renderSnapshot } from "@ren-ai/plugin-session-folder/files";
import type { PersonaPluginOptions } from "@ren-ai/plugin-application";
import { personaPlugins } from "./persona-plugins.test-helper.ts";

const disabled = [
  "opencode.config.compatibility",
  "opencode.provider.ollama",
  "opencode.provider.lmstudio",
  "opencode.provider.vllm",
];

interface HostConfig {
  readonly configDirectory: string;
  readonly databasePath: string;
  readonly providers: Readonly<Record<string, object>>;
  readonly model: string;
  readonly memory?: {
    readonly contextTokens: number;
    readonly budgetTokens: number;
    readonly recentTokens: number;
  };
  readonly overrides?: Parameters<typeof createEmbeddedRoutes>[1];
}

export type HostOptions = HostConfig & PersonaPluginOptions;
type WithoutPersonas<T> = T extends object ? Omit<T, "personas"> : never;
export type PersonaHostOptions = HostConfig & WithoutPersonas<PersonaPluginOptions>;

export const createHost = (options: HostOptions) =>
  Effect.gen(function* () {
    const memory = options.memory ?? {
      contextTokens: 100_000,
      budgetTokens: 60_000,
      recentTokens: 12_000,
    };
    if (
      !Number.isInteger(memory.contextTokens) ||
      !Number.isInteger(memory.budgetTokens) ||
      !Number.isInteger(memory.recentTokens) ||
      memory.budgetTokens >= memory.contextTokens ||
      memory.recentTokens <= 0 ||
      memory.recentTokens >= memory.budgetTokens
    )
      return yield* Effect.fail(new Error("Invalid Memory budget"));
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() =>
        ManagedRuntime.make(
          createEmbeddedRoutes(
            {
              database: { path: options.databasePath },
              config: {
                directory: options.configDirectory,
                project: true,
                content: JSON.stringify({
                  plugins: disabled.map((id) => `-${id}`),
                  providers: options.providers,
                  compaction: {
                    buffer: memory.contextTokens - memory.budgetTokens,
                    keep: { tokens: memory.recentTokens },
                  },
                }),
              },
              models: { fetch: false },
            },
            options.overrides,
          ).pipe(Layer.provide(HttpServer.layerServices)),
        ),
      ),
      (resource) => resource.disposeEffect,
    );
    const services = yield* runtime.contextEffect;
    const sessions = Context.get(services, Session.Service);
    const plugins = Context.get(services, SdkPlugins.Service);
    yield* Effect.tryPromise(() =>
      runtime.runPromise(plugins.register(sessionFolderPlugin(options.personaDirectory))),
    );
    yield* Effect.forEach(personaPlugins(options), (plugin) =>
      Effect.tryPromise(() => runtime.runPromise(plugins.register(plugin))),
    );
    const web = HttpEffect.toWebHandlerWith<
      typeof services extends Context.Context<infer Provided> ? Provided : never,
      Scope.Scope | HttpServerRequest.HttpServerRequest
    >(services)(Context.get(services, HttpRouter.HttpRouter).asHttpEffect());
    return {
      personas: options.personas,
      sessions,
      events: Context.get(services, Bus.Service),
      plugins,
      outcomes: Context.get(services, Bus.Service).subscribe([
        SessionEvent.Execution.Failed,
        SessionEvent.Execution.Succeeded,
      ]),
      retry: sessions.resume,
      run: runtime.runPromise.bind(runtime),
      web,
      createSession: (personaID: string) =>
        Effect.gen(function* () {
          if (!options.personas.has(personaID))
            return yield* Effect.fail(new Error(`Unknown persona: ${personaID}`));
          const id = Session.ID.create();
          const directory = yield* Effect.tryPromise(async () =>
            folderFiles(options.personaDirectory).write(
              id,
              renderSnapshot(options.personas.get(personaID)!, await loadGroundRules()),
            ),
          );
          return yield* sessions.create({
            id,
            agent: Agent.ID.make(personaID),
            model: Model.Ref.parse(options.model),
            location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
            permissions: [
              { action: "*", resource: "*", effect: "deny" },
              ...(options.send
                ? [{ action: "send", resource: "*", effect: "allow" } as const]
                : []),
              ...(options.wait
                ? [{ action: "wait", resource: "*", effect: "allow" } as const]
                : []),
              ...(options.read
                ? [{ action: "read", resource: "*", effect: "allow" } as const]
                : []),
              ...(options.react
                ? [{ action: "react", resource: "*", effect: "allow" } as const]
                : []),
            ],
          });
        }),
    };
  });
