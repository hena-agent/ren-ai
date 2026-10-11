import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { NodeRuntime } from "@effect/platform-node";
import { startDiscovery } from "./discovery/server.ts";

const database =
  process.env.DISCOVERY_DATABASE ??
  fileURLToPath(new URL("../data/discovery.sqlite", import.meta.url));
await mkdir(dirname(database), { recursive: true });
const port = Number(process.env.PORT ?? 4867);
NodeRuntime.runMain(
  Effect.scoped(
    startDiscovery({
      port,
      catalogUrl: process.env.PERSONA_CATALOG_URL ?? "http://127.0.0.1:3729",
      turnstileSecret: process.env.TURNSTILE_SECRET ?? "",
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => process.stdout.write(`[discovery-api] http://127.0.0.1:${port}\n`)),
      ),
      Effect.andThen(Effect.never),
      Effect.provide(
        Layer.mergeAll(
          FetchHttpClient.layer,
          SqliteClient.layer({ filename: database, busyTimeout: "5 seconds" }),
        ),
      ),
    ),
  ),
);
