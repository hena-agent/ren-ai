import { SdkPlugins } from "@opencode/core/plugin/sdk";
import { Session } from "@opencode/core/session";
import { createEmbeddedRoutes } from "@opencode/server/routes";
import { AbsolutePath, Agent, Location, Model } from "@opencode/schema";
import { Plugin } from "@opencode/plugin/effect";
import { Tool } from "@opencode/schema/tool";
import { Context, Effect, Layer, ManagedRuntime, Schema, Scope } from "effect";
import { HttpEffect, HttpRouter, HttpServer, HttpServerRequest } from "effect/unstable/http";
import type { Persona } from "../personas/personas.ts";

const disabled = [
  "opencode.config.instruction",
  "opencode.config.compatibility",
  "opencode.provider.ollama",
  "opencode.provider.lmstudio",
  "opencode.provider.vllm",
];

export interface HostOptions {
  readonly configDirectory: string;
  readonly databasePath: string;
  readonly personaDirectory: string;
  readonly personas: ReadonlyMap<string, Persona>;
  readonly providers: Readonly<Record<string, object>>;
  readonly model: string;
  /** Resolve the Handle from the durable Conversation→session binding. */
  readonly handleForSession: (sessionID: string) => Effect.Effect<string | undefined>;
  readonly overrides?: Parameters<typeof createEmbeddedRoutes>[1];
  readonly send?: (sessionID: string, text: string, callID: string) => Effect.Effect<string, Error>;
}

export const createHost = (options: HostOptions) =>
  Effect.gen(function* () {
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() =>
        ManagedRuntime.make(
          createEmbeddedRoutes(
            {
              database: { path: options.databasePath },
              config: {
                directory: options.configDirectory,
                project: false,
                content: JSON.stringify({
                  plugins: disabled.map((id) => `-${id}`),
                  providers: options.providers,
                  agents: Object.fromEntries(
                    [...options.personas.keys()].map((id) => [id, { mode: "primary" }]),
                  ),
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
    const plugin = Plugin.define({
      id: "personas",
      effect: (ctx) =>
        Effect.gen(function* () {
          yield* ctx.agent.transform((editor) => {
            for (const persona of options.personas.values()) {
              editor.update(persona.id, (agent) => {
                agent.system = persona.prompt;
                agent.description = persona.openingLine;
                agent.permissions = [{ action: "*", resource: "*", effect: "deny" }];
              });
            }
          });
          if (options.send) {
            const send = options.send;
            yield* ctx.tool.transform((editor) => {
              editor.add({
                name: "send",
                description: "Send one iMessage bubble to this Conversation's User",
                input: Schema.Struct({ text: Schema.String }),
                output: Schema.String,
                options: { codemode: false },
                execute: ({ text }, context) =>
                  send(context.sessionID, text, context.id).pipe(
                    Effect.map((output) => ({ output, content: output })),
                    Effect.mapError((error) => new Tool.Error({ message: error.message })),
                  ),
              });
            });
          }
          yield* ctx.session.hook("context", (event) =>
            Effect.sync(() => {
              const persona = options.personas.get(event.agent)!;
              event.system.splice(0, event.system.length, { type: "text", text: persona.prompt });
              for (const name of Object.keys(event.tools)) {
                if (name !== "send" || !options.send) delete event.tools[name];
              }
            }),
          );
          yield* ctx.session.hook("title", (event) =>
            Effect.gen(function* () {
              const handle = yield* options.handleForSession(event.sessionID);
              if (!handle) return;
              const session = yield* sessions.get(event.sessionID).pipe(Effect.orDie);
              const persona = session.agent!;
              event.result = `${persona[0]!.toUpperCase()}${persona.slice(1)} · ${handle}`;
            }),
          );
        }),
    });
    const plugins = Context.get(services, SdkPlugins.Service);
    yield* Effect.tryPromise(() => runtime.runPromise(plugins.register(plugin)));
    const web = HttpEffect.toWebHandlerWith<
      typeof services extends Context.Context<infer Provided> ? Provided : never,
      Scope.Scope | HttpServerRequest.HttpServerRequest
    >(services)(Context.get(services, HttpRouter.HttpRouter).asHttpEffect());
    return {
      sessions,
      plugins,
      run: runtime.runPromise.bind(runtime),
      web,
      createSession: (personaID: string) => {
        if (!options.personas.has(personaID)) {
          return Effect.fail(new Error(`Unknown persona: ${personaID}`));
        }
        return sessions.create({
          agent: Agent.ID.make(personaID),
          model: Model.Ref.parse(options.model),
          location: Location.Ref.make({ directory: AbsolutePath.make(options.personaDirectory) }),
          permissions: [
            { action: "*", resource: "*", effect: "deny" },
            ...(options.send ? [{ action: "send", resource: "*", effect: "allow" } as const] : []),
          ],
        });
      },
    };
  });
