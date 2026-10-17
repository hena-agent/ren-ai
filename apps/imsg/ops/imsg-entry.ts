import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Logger } from "effect";
import { startMessagingGateway } from "../src/gateway/runtime.ts";

process.umask(0o077);

NodeRuntime.runMain(
  Effect.scoped(startMessagingGateway.pipe(Effect.andThen(Effect.never))).pipe(
    Effect.provide(NodeServices.layer),
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
