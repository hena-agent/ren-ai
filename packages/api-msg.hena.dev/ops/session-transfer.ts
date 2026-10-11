import { Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { remoteHost } from "../src/opencode/remote.ts";
import { runSessionTransfer } from "../src/operations/session-transfer.ts";
import { catalogClient } from "../src/personas/catalog.ts";

const [command, file] = process.argv.slice(2);
const operation = Schema.decodeUnknownSync(
  Schema.Literals(["export", "restore", "plugins", "folders"]),
)(command);
const baseUrl = process.env["OPENCODE_URL"];
const authorization = process.env["OPENCODE_AUTHORIZATION"];
const directory = process.env["OPENCODE_DIRECTORY"] ?? "/srv/ren-ai";
if (!file || !baseUrl || !authorization)
  throw new Error(
    "Usage: OPENCODE_URL=... OPENCODE_AUTHORIZATION=... bun ops/session-transfer.ts export|restore|plugins|folders FILE",
  );
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const host = yield* remoteHost(
        { baseUrl, authorization, directory, model: "opencode-go/deepseek-v4.1-flash" },
        new Map(),
      );
      yield* runSessionTransfer(host.client, {
        operation,
        file,
        directory,
        confirmation: process.env["CONFIRM_BOOTSTRAP_ONLY"],
        ...(process.env["PERSONA_CATALOG_URL"]
          ? {
              personas: (yield* Effect.tryPromise(
                catalogClient({
                  url: process.env["PERSONA_CATALOG_URL"],
                  token: process.env["PERSONA_CATALOG_TOKEN"] ?? "",
                }).load,
              )).personas,
            }
          : {}),
      });
    }),
  ).pipe(Effect.provide(FetchHttpClient.layer)),
);
