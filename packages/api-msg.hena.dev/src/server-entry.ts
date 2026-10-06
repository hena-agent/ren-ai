import { join } from "node:path";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Effect, FileSystem, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { applicationConfig } from "./configuration.ts";
import { composeServer } from "./server.ts";

NodeRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* applicationConfig;
      const files = yield* FileSystem.FileSystem;
      yield* files.makeDirectory(config.stateDirectory, { recursive: true, mode: 0o700 });
      yield* composeServer(config).pipe(
        Effect.andThen(Effect.never),
        Effect.provide(
          SqliteClient.layer({ filename: join(config.stateDirectory, "server.sqlite") }),
        ),
      );
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
);
