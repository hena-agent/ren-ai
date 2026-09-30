import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { startMessagingGateway } from "../src/gateway/runtime.ts";

NodeRuntime.runMain(
  Effect.scoped(startMessagingGateway.pipe(Effect.andThen(Effect.never))).pipe(
    Effect.provide(NodeServices.layer),
  ),
);
