import { Plugin } from "@opencode/plugin/effect";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { managedFolder } from "@ren-ai/plugin-session-folder/paths";
import { Effect, Option, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { applicationApi, persona } from "./protocol.ts";
import { rpcClient } from "./rpc.ts";
import type { PersonaPluginOptions } from "./options.ts";

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

const remoteOptions = (config: RemoteConfig) =>
  Effect.gen(function* () {
    const api = yield* rpcClient(applicationApi, config);
    const options: PersonaPluginOptions = {
      personaDirectory: config.directory,
      personas: new Map(),
      send: (sessionID, text, callID) =>
        api.send({ sessionID, text, callID }).pipe(Effect.mapError(failure)),
      wait: (sessionID, minutes) =>
        api.wait({ sessionID, minutes }).pipe(
          Stream.filter((output) => output !== ""),
          Stream.runLast,
          Effect.flatMap((result) =>
            Option.isSome(result)
              ? Effect.succeed(result.value)
              : Effect.fail(new Error("Wait stream ended without a result")),
          ),
          Effect.mapError(failure),
        ),
      read: (sessionID) => api.read({ sessionID }).pipe(Effect.mapError(failure)),
      react: (sessionID, tapback, callID) =>
        api.react({ sessionID, tapback, callID }).pipe(Effect.mapError(failure)),
      handleForSession: (sessionID) => api.handle({ sessionID }).pipe(Effect.mapError(failure)),
      onContext: (sessionID) => api.context({ sessionID }).pipe(Effect.mapError(failure)),
      lastMessageStatus: (sessionID) => api.status({ sessionID }).pipe(Effect.mapError(failure)),
      settledSends: (sessionID) => api.sends({ sessionID }).pipe(Effect.mapError(failure)),
      health: {
        raise: (name, detail) => api.alert({ name, detail }).pipe(Effect.catch(() => Effect.void)),
      },
    };
    return options;
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
        const options = yield* remoteOptions(config);
        yield* factory(options).effect(ctx);
      }).pipe(Effect.orDie, Effect.provide(FetchHttpClient.layer)),
  });

const configSchema = Schema.Struct({
  directory: Schema.String,
  url: Schema.String,
  tokenFile: Schema.String,
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
        const token = yield* Effect.tryPromise(() => readFile(config.tokenFile, "utf8"));
        yield* remotePlugin(id, factory, {
          ...config,
          token: token.trim(),
        }).effect(ctx);
      }).pipe(Effect.orDie),
  });
