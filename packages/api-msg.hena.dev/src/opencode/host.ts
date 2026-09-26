import { SdkPlugins } from "@opencode/core/plugin/sdk";
import { Session } from "@opencode/core/session";
import { createEmbeddedRoutes } from "@opencode/server/routes";
import { AbsolutePath, Agent, Location, Model } from "@opencode/schema";
import { Plugin } from "@opencode/plugin/effect";
import { Tool } from "@opencode/schema/tool";
import { Clock, Context, Effect, Layer, ManagedRuntime, Schema, Scope } from "effect";
import { HttpEffect, HttpRouter, HttpServer, HttpServerRequest } from "effect/unstable/http";
import type { Persona } from "../personas/personas.ts";
import { tapbacks, type Tapback } from "../outbox/outbox.ts";
import type { OutgoingStatus } from "../messages/messages.ts";
import { phone } from "../transcript/transcript.ts";
import { cleanContext } from "./context.ts";

const disabled = [
  "opencode.config.instruction",
  "opencode.config.compatibility",
  "opencode.provider.ollama",
  "opencode.provider.lmstudio",
  "opencode.provider.vllm",
];

function toolResult(action: Effect.Effect<string, Error>) {
  return action.pipe(
    Effect.map((output) => ({ output, content: output })),
    Effect.mapError((error) => new Tool.Error({ message: error.message })),
  );
}

interface HostConfig {
  readonly configDirectory: string;
  readonly databasePath: string;
  readonly personaDirectory: string;
  readonly personas: ReadonlyMap<string, Persona>;
  readonly providers: Readonly<Record<string, object>>;
  readonly model: string;
  /** The model's context limit, our compaction threshold, and the verbatim tail. */
  readonly memory?: {
    readonly contextTokens: number;
    readonly budgetTokens: number;
    readonly recentTokens: number;
  };
  /** Resolve the Handle from the durable Conversation→session binding. */
  readonly handleForSession: (sessionID: string) => Effect.Effect<string | undefined>;
  readonly overrides?: Parameters<typeof createEmbeddedRoutes>[1];
  readonly read?: (sessionID: string) => Effect.Effect<string, Error>;
  readonly react?: (
    sessionID: string,
    tapback: Tapback,
    callID: string,
  ) => Effect.Effect<string, Error>;
  readonly onContext?: (sessionID: string) => Effect.Effect<void, Error>;
  readonly lastMessageStatus?: (
    sessionID: string,
  ) => Effect.Effect<OutgoingStatus | undefined, Error>;
  readonly health: { readonly raise: (name: string, detail?: string) => Effect.Effect<void> };
}

type HostTools =
  | {
      readonly send: (
        sessionID: string,
        text: string,
        callID: string,
      ) => Effect.Effect<string, Error>;
      readonly wait: (sessionID: string, minutes: number) => Effect.Effect<string, Error>;
    }
  | { readonly send?: undefined; readonly wait?: undefined };

export type HostOptions = HostConfig & HostTools;
export type PersonaHostOptions = Omit<HostConfig, "personas"> & HostTools;

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
                project: false,
                content: JSON.stringify({
                  plugins: disabled.map((id) => `-${id}`),
                  providers: options.providers,
                  agents: Object.fromEntries(
                    [...options.personas.keys()].map((id) => [id, { mode: "primary" }]),
                  ),
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
            const wait = options.wait;
            yield* ctx.tool.transform((editor) => {
              editor.add({
                name: "send",
                description: "Send one iMessage bubble to this Conversation's User",
                input: Schema.Struct({ text: Schema.String }),
                output: Schema.String,
                options: { codemode: false },
                execute: ({ text }, context) =>
                  toolResult(send(context.sessionID, text, context.id)),
              });
              editor.add({
                name: "wait",
                description: "Pause for up to 12 hours, or until something new arrives",
                input: Schema.Struct({ minutes: Schema.Number.check(Schema.isGreaterThan(0)) }),
                output: Schema.String,
                options: { codemode: false },
                execute: ({ minutes }, context) => toolResult(wait(context.sessionID, minutes)),
              });
            });
          }
          if (options.read) {
            const read = options.read;
            yield* ctx.tool.transform((editor) => {
              editor.add({
                name: "read",
                description: "Mark this Conversation's messages read now",
                input: Schema.Struct({}),
                output: Schema.String,
                options: { codemode: false },
                execute: (_, context) => toolResult(read(context.sessionID)),
              });
            });
          }
          if (options.react) {
            const react = options.react;
            yield* ctx.tool.transform((editor) => {
              editor.add({
                name: "react",
                description: "React to his latest message with a standard tapback",
                input: Schema.Struct({ tapback: Schema.Literals(tapbacks) }),
                output: Schema.String,
                options: { codemode: false },
                execute: ({ tapback }, context) =>
                  toolResult(react(context.sessionID, tapback, context.id)),
              });
            });
          }
          yield* ctx.session.hook("context", (event) =>
            Effect.gen(function* () {
              const persona = options.personas.get(event.agent)!;
              const now = yield* Clock.currentTimeMillis;
              const status = yield* (
                options.lastMessageStatus?.(event.sessionID) ?? Effect.succeed(undefined)
              ).pipe(Effect.orDie);
              const state = status?.readAt ?? (status?.delivered ? "delivered" : "sent");
              const removed = cleanContext(
                event,
                persona.prompt,
                phone(now, persona.timeZone, state),
                new Set(
                  (["send", "read", "react", "wait"] as const).filter((name) => options[name]),
                ),
              );
              if (options.onContext) yield* options.onContext(event.sessionID);
              yield* Effect.forEach(removed, (name) =>
                options.health.raise(
                  "unexpected-tool",
                  `OpenCode offered disallowed tool: ${name}`,
                ),
              );
            }).pipe(Effect.orDie),
          );
          yield* ctx.session.hook("compaction", (event) =>
            Effect.gen(function* () {
              const persona = options.personas.get(event.agent)!;
              const { text: summary } = yield* ctx.session.generate({
                sessionID: event.sessionID,
                prompt: `${persona.memory}\nWrite her Memory in ${persona.language}, from her point of view. Use four parts: about him, the two of them, plans and promises, and lately. Preserve his name once learned, even through later summaries. Describe photos worth remembering. Update any previous Memory with what happened since; never discard lasting facts just because they are old. Return only the four-part Memory, not a conversation checkpoint wrapper. Do not call tools.`,
              });
              if (!summary.trim()) yield* Effect.fail(new Error());
              event.result = { summary };
            }).pipe(Effect.orDie),
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
      personas: options.personas,
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
            ...(options.wait ? [{ action: "wait", resource: "*", effect: "allow" } as const] : []),
            ...(options.read ? [{ action: "read", resource: "*", effect: "allow" } as const] : []),
            ...(options.react
              ? [{ action: "react", resource: "*", effect: "allow" } as const]
              : []),
          ],
        });
      },
    };
  });
