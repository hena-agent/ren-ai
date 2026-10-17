import { join, resolve } from "node:path";
import { Config, Effect } from "effect";
import { makeRustpushMessages } from "../messages/rustpush.ts";
import { servePublic } from "@ren-ai/transport/listener";
import { messageGateway } from "./server.ts";

/** The handle every persona texts from (ADR-0016). */
const serviceHandle = "hi@renai.im";

export const startMessagingGateway = Effect.gen(function* () {
  const config = yield* Config.all({
    token: Config.string("IMSG_TOKEN"),
    port: Config.int("IMSG_PORT").pipe(Config.withDefault(4702)),
    hostname: Config.string("IMSG_LISTEN_HOST").pipe(Config.withDefault("127.0.0.1")),
    // The installed LaunchAgent runs in its messaging home; tests and local runs choose another.
    home: Config.string("IMSG_HOME").pipe(Config.withDefault(".")),
  });
  const health = {
    raise: (name: string, detail: string) => Effect.logWarning(`${name}: ${detail}`),
    clear: () => Effect.void,
  };
  const home = resolve(config.home);
  const { messages, gestures } = yield* makeRustpushMessages(
    {
      command: join(home, "ren-rustpush"),
      state: join(home, "rustpush"),
      history: join(home, "history.sqlite"),
      handle: serviceHandle,
    },
    health,
  );
  const gateway = messageGateway(messages, config.token, gestures);
  yield* Effect.addFinalizer(() => Effect.promise(gateway.dispose));
  const listener = yield* servePublic(gateway.handler, config.port, config.hostname);
  return { listener };
});
