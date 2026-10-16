import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Logger } from "effect";
import { startMessagingGateway } from "../src/gateway/runtime.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { MessageMetadata, messageMetadata } from "../src/messages/message-metadata.ts";

NodeRuntime.runMain(
  Effect.scoped(startMessagingGateway.pipe(Effect.andThen(Effect.never))).pipe(
    Effect.provide(NodeServices.layer),
    Effect.provideService(
      MessageMetadata,
      messageMetadata(join(homedir(), "Library/Messages/chat.db")),
    ),
    Effect.provide(
      Logger.layer([
        Logger.make((entry) => {
          const stream =
            entry.logLevel === "Warn" || entry.logLevel === "Error" || entry.logLevel === "Fatal"
              ? process.stderr
              : process.stdout;
          stream.write(`${Logger.formatJson.log(entry)}\n`);
        }),
      ]),
    ),
  ),
);
