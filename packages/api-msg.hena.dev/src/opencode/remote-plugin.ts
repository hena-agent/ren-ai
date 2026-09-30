import { Plugin } from "@opencode/plugin/effect";
import { readFile } from "node:fs/promises";
import { Effect, Option, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { rpcClient } from "../transport/rpc.ts";
import type { Tapback } from "../outbox/outbox.ts";
import { applicationApi } from "./application-protocol.ts";
import { personaPlugin } from "./plugin.ts";

const failure = (error: Error | string) => new Error(String(error));

export const remotePersonaPlugin = (config: {
  readonly url: string;
  readonly token: string;
  readonly directory: string;
}) =>
  Plugin.define({
    id: "personas",
    effect: (ctx) =>
      Effect.gen(function* () {
        if (ctx.location.directory !== config.directory) return;
        const api = yield* rpcClient(applicationApi, config);
        const personas = yield* api.catalog();
        yield* personaPlugin({
          personaDirectory: config.directory,
          personas: new Map(personas.map((persona) => [persona.id, persona])),
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
          react: (sessionID, tapback: Tapback, callID) =>
            api.react({ sessionID, tapback, callID }).pipe(Effect.mapError(failure)),
          handleForSession: (sessionID) => api.handle({ sessionID }).pipe(Effect.mapError(failure)),
          onContext: (sessionID) => api.context({ sessionID }).pipe(Effect.mapError(failure)),
          lastMessageStatus: (sessionID) =>
            api.status({ sessionID }).pipe(Effect.mapError(failure)),
          settledSends: (sessionID) => api.sends({ sessionID }).pipe(Effect.mapError(failure)),
          health: {
            raise: (name, detail) =>
              api.alert({ name, detail }).pipe(Effect.catch(() => Effect.void)),
          },
        }).effect(ctx);
      }).pipe(Effect.orDie, Effect.provide(FetchHttpClient.layer)),
  });

const options = Schema.Struct({
  directory: Schema.String,
  url: Schema.String,
  tokenFile: Schema.String,
});

export default Plugin.define({
  id: "personas",
  effect: (ctx) =>
    Effect.gen(function* () {
      const config = yield* Schema.decodeUnknownEffect(options)(ctx.options);
      if (ctx.location.directory !== config.directory) return;
      const token = yield* Effect.tryPromise(() => readFile(config.tokenFile, "utf8"));
      yield* remotePersonaPlugin({ ...config, token: token.trim() }).effect(ctx);
    }).pipe(Effect.orDie),
});
