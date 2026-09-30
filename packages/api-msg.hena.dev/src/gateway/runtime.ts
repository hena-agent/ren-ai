import { Config, Effect } from "effect";
import { makeImsgMessages } from "../messages/imsg.ts";
import { makeMessagesUi } from "../gestures/messages-ui.ts";
import { servePublic } from "../public-listener.ts";
import { messageGateway } from "./server.ts";

export const startMessagingGateway = Effect.gen(function* () {
  const config = yield* Config.all({
    token: Config.string("IMSG_TOKEN"),
    port: Config.int("IMSG_PORT").pipe(Config.withDefault(4702)),
    hostname: Config.string("IMSG_LISTEN_HOST").pipe(Config.withDefault("127.0.0.1")),
  });
  const health = {
    raise: (name: string, detail: string) => Effect.logWarning(`${name}: ${detail}`),
    clear: () => Effect.void,
  };
  const messages = yield* makeImsgMessages(health);
  const gestures = yield* makeMessagesUi(health);
  const gateway = messageGateway(messages, config.token, gestures);
  yield* Effect.addFinalizer(() => Effect.promise(gateway.dispose));
  const listener = yield* servePublic(gateway.handler, config.port, config.hostname);
  return { listener };
});
