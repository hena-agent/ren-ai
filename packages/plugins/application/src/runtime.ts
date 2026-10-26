import { Plugin } from "@opencode/plugin/effect";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { managedFolder } from "@ren-ai/plugin-session-folder/paths";
import { readSessionBinding } from "@ren-ai/plugin-session-folder/bindings";
import { Cause, Effect, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { applicationApi, persona } from "./protocol.ts";
import { rpcClient } from "@ren-ai/transport/client";
import type { PersonaPluginOptions } from "./options.ts";
import { localWait } from "./wait.ts";
import { observationFailure, observeTurns } from "./observe.ts";
import { resilientContext } from "./context.ts";

export const inPersonaLocation = (directory: string, root: string) => {
  return (
    resolve(directory) === resolve(root) ||
    managedFolder(resolve(root), resolve(directory)) !== undefined
  );
};

export const getPersona = (
  options: PersonaPluginOptions,
  agent: string,
  directory = options.personaDirectory,
) => {
  if (resolve(directory) === resolve(options.personaDirectory))
    return Effect.succeed(options.personas.get(agent));
  return readPersona(directory).pipe(
    Effect.flatMap((snapshot) =>
      snapshot.id === agent
        ? Effect.succeed(options.personas.get(agent) ?? snapshot)
        : Effect.fail(
            new Error(
              `Session persona binding mismatch: expected ${snapshot.id}, received ${agent}`,
            ),
          ),
    ),
  );
};

const failure = (error: Error | string) => new Error(String(error));
export const readPersona = (directory: string) =>
  Effect.tryPromise({
    try: () => readFile(join(directory, "persona.json"), "utf8"),
    catch: (error) => new Error(String(error)),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(persona))),
    Effect.mapError(failure),
  );
interface RemoteConfig {
  readonly directory: string;
  readonly url: string;
  readonly token: string;
}

const remoteOptions = <E>(
  config: RemoteConfig,
  events: Stream.Stream<{ type: string; data?: { sessionID: string; messageID?: string } }, E>,
) =>
  Effect.gen(function* () {
    const api = yield* rpcClient(applicationApi, config);
    const waiting = yield* localWait(
      events.pipe(
        Stream.filter(
          (event) => event.type === "session.inbox.enqueued" && event.data?.messageID !== undefined,
        ),
        Stream.map((event) => ({
          sessionID: event.data!.sessionID,
          messageID: event.data!.messageID!,
        })),
      ),
    );
    yield* observeTurns(events, (sessionID) => api.observe({ sessionID }));
    const options: PersonaPluginOptions = {
      personaDirectory: config.directory,
      personas: new Map(),
      send: (sessionID, text, callID) =>
        api.send({ sessionID, text, callID }).pipe(Effect.mapError(failure)),
      takePhoto: (sessionID, input, callID) =>
        api.takePhoto({ sessionID, input, callID }).pipe(Effect.mapError(failure)),
      sendPhoto: (sessionID, photo, callID) =>
        api.sendPhoto({ sessionID, photo, callID }).pipe(Effect.mapError(failure)),
      endConversation: (sessionID, farewell, callID) =>
        api.endConversation({ sessionID, farewell, callID }).pipe(Effect.mapError(failure)),
      wait: waiting.wait,
      read: (sessionID) => api.read({ sessionID }).pipe(Effect.mapError(failure)),
      react: (sessionID, tapback, callID) =>
        api.react({ sessionID, tapback, callID }).pipe(Effect.mapError(failure)),
      handleForSession: (sessionID) => api.handle({ sessionID }).pipe(Effect.mapError(failure)),
      context: (sessionID, messageIDs) =>
        resilientContext(api.context({ sessionID, messageIDs }), sessionID),
      health: {
        raise: (name, detail) => api.alert({ name, detail }).pipe(Effect.catch(() => Effect.void)),
      },
    };
    return { options, observed: waiting.observed };
  });

type Factory = (options: PersonaPluginOptions) => Plugin.Plugin;

export const remotePlugin = (id: string, factory: Factory, config: RemoteConfig) =>
  Plugin.define({
    id,
    effect: (ctx) =>
      Effect.gen(function* () {
        if (
          resolve(ctx.location.directory) === resolve(config.directory) ||
          !inPersonaLocation(ctx.location.directory, config.directory)
        )
          return;
        const remote = yield* remoteOptions(
          config,
          id === "ren-ai.tools"
            ? ctx.event.subscribe().pipe(
                Stream.filter(
                  (event) =>
                    event.type === "session.inbox.enqueued" ||
                    event.type === "session.execution.failed" ||
                    event.type === "session.execution.succeeded",
                ),
                Stream.filterEffect((event) => {
                  const requestId = crypto.randomUUID();
                  const started = performance.now();
                  return ctx.session.get({ sessionID: event.data.sessionID }).pipe(
                    Effect.map((session) => session.location.directory === ctx.location.directory),
                    Effect.catchCause((cause) =>
                      Effect.sync(() => {
                        observationFailure(Cause.squash(cause), "turn.session", requestId, started);
                        return false;
                      }),
                    ),
                  );
                }),
                Stream.map((event) => ({
                  type: event.type,
                  data: {
                    sessionID: event.data.sessionID,
                    ...(event.type === "session.inbox.enqueued"
                      ? { messageID: event.data.inboxID }
                      : {}),
                  },
                })),
              )
            : Stream.never,
        );
        yield* ctx.session.hook("context", (event) =>
          Effect.sync(() =>
            remote.observed(
              event.sessionID,
              event.messages.flatMap((entry) => entry.id ?? []),
            ),
          ),
        );
        yield* factory({
          ...remote.options,
          wait: (sessionID: string, seconds: number) =>
            Effect.tryPromise({
              try: () => readSessionBinding(ctx.location.directory, sessionID),
              catch: (error) => new Error(String(error)),
            }).pipe(
              Effect.flatMap((binding) =>
                binding.writable
                  ? remote.options.wait(sessionID, seconds)
                  : Effect.succeed("This session is read-only. Finish this turn without waiting."),
              ),
            ),
        }).effect(ctx);
      }).pipe(Effect.orDie, Effect.provide(FetchHttpClient.layer)),
  });

const configSchema = Schema.Struct({
  directory: Schema.String,
  url: Schema.String,
});

export const configuredPlugin = (id: string, factory: Factory) =>
  Plugin.define({
    id,
    effect: (ctx) =>
      Effect.gen(function* () {
        const config = yield* Schema.decodeUnknownEffect(configSchema)(ctx.options);
        if (
          resolve(ctx.location.directory) === resolve(config.directory) ||
          !inPersonaLocation(ctx.location.directory, config.directory)
        )
          return;
        const token = process.env["TOKEN_MANAGEMENT"]?.trim();
        if (!token) throw new Error("TOKEN_MANAGEMENT is required");
        yield* remotePlugin(id, factory, {
          ...config,
          token,
        }).effect(ctx);
      }).pipe(Effect.orDie),
  });
