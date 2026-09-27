import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { makeImsgMessages, makeMessagesUi } from "./main.ts";
import { composeServer } from "./server.ts";

const state = process.env["XDG_STATE_HOME"];
if (!state) throw new Error("XDG_STATE_HOME is required");
process.env["PATH"] =
  "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Users/chris/.bun/bin";
const keychain = (name: string, account = "api-msg") =>
  execFileSync(
    "/usr/bin/security",
    ["find-generic-password", "-w", "-s", `dev.hena.ren-ai.${name}`, "-a", account],
    { encoding: "utf8" },
  ).trim();
const secrets = {
  OPENCODE_GO_KEY: keychain("opencode-go", "personas"),
  TURNSTILE_SECRET: keychain("turnstile"),
  VIEWER_PASSWORD: keychain("viewer"),
  DISCORD_WEBHOOK_URL: keychain("discord"),
  HEARTBEAT_URL: keychain("heartbeat"),
  R2_ACCESS_KEY_ID: keychain("r2-access-key-id"),
  R2_SECRET_ACCESS_KEY: keychain("r2-secret-access-key"),
  R2_ENDPOINT: keychain("r2-endpoint"),
  BACKUP_KEY: keychain("backup-key"),
};
if (Object.values(secrets).some((value) => !value)) throw new Error("Empty Keychain secret");
const controller = new AbortController();
process.on("SIGTERM", () => controller.abort());
process.on("SIGINT", () => controller.abort());
await Effect.runPromise(
  Effect.scoped(
    composeServer(
      {
        stateDirectory: state,
        personaDirectory: "/Users/chris/git/hena-agent/persona",
        publicPort: 4700,
        viewerPort: 4701,
        bucket: "ren-ai",
        secrets,
      },
      { messages: makeImsgMessages, gestures: makeMessagesUi },
    ).pipe(
      Effect.andThen(Effect.never),
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          FetchHttpClient.layer,
          SqliteClient.layer({ filename: join(state, "server.sqlite") }),
        ),
      ),
    ),
  ),
  { signal: controller.signal },
);
