import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { startDiscovery } from "./discovery/server.ts";

const database =
  process.env.DISCOVERY_DATABASE ??
  fileURLToPath(new URL("../data/discovery.sqlite", import.meta.url));
await mkdir(dirname(database), { recursive: true });
const port = Number(process.env.PORT ?? 4867);
const stop = new AbortController();
process.on("SIGTERM", () => stop.abort());
process.on("SIGINT", () => stop.abort());
await Effect.runPromise(
  Effect.scoped(
    startDiscovery({
      port,
      personaDirectory:
        process.env.PERSONA_DIRECTORY ??
        fileURLToPath(new URL("../../../apps/admin/data/personas", import.meta.url)),
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
  { signal: stop.signal },
);
