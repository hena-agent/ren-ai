import { Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { remoteHost } from "../src/opencode/remote.ts";
import { runSessionTransfer } from "../src/operations/session-transfer.ts";
import { catalogClient } from "../src/personas/catalog.ts";
import { loadGroundRules } from "@ren-ai/plugin-session-folder/files";

const [command, file, applicationFile] = process.argv.slice(2);
const operation = Schema.decodeUnknownSync(
  Schema.Literals(["export", "restore", "plugins", "shared-life"]),
)(command);
const baseUrl = process.env["OPENCODE_URL"];
const authorization = process.env["OPENCODE_AUTHORIZATION"];
const directory = process.env["OPENCODE_DIRECTORY"] ?? "/srv/ren-ai";
if (!file || !baseUrl || !authorization)
  throw new Error(
    "Usage: OPENCODE_URL=... OPENCODE_AUTHORIZATION=... bun ops/session-transfer.ts export|restore|plugins|shared-life FILE [APPLICATION-STATE.json]",
  );
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const host = yield* remoteHost(
        {
          baseUrl,
          authorization,
          directory,
          model: "opencode-go/deepseek-v4.1-flash",
          groundRules: yield* Effect.tryPromise(loadGroundRules),
        },
        new Map(),
      );
      yield* runSessionTransfer(host.client, {
        operation,
        file,
        ...(applicationFile ? { applicationFile } : {}),
        directory,
        confirmation: process.env["CONFIRM_BOOTSTRAP_ONLY"],
        ...(process.env["PERSONA_CATALOG_URL"]
          ? {
              personas: (yield* Effect.tryPromise(
                catalogClient({
                  url: process.env["PERSONA_CATALOG_URL"],
                  token: process.env["TOKEN_CATALOG"] ?? "",
                }).load,
              )).personas,
            }
          : {}),
      });
    }),
  ).pipe(Effect.provide(FetchHttpClient.layer)),
);
