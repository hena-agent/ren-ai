import type { OpenCode } from "@opencode/client/effect";
import { Effect } from "effect";
import { readFile, writeFile } from "node:fs/promises";
import { exportSessions, restoreSessions, type FolderSnapshotIO } from "../opencode/transfer.ts";
import type { Persona } from "@ren-ai/personas";
import { managedSessions } from "../opencode/managed-sessions.ts";
import { runSharedLifeCutover } from "./shared-life-cutover.ts";
import { sessionFolders } from "@ren-ai/plugin-session-folder/protocol";

type Client = Effect.Success<ReturnType<typeof OpenCode.make>>;

export const exportLocation = (client: Client, directory: string, folderIO?: FolderSnapshotIO) =>
  Effect.gen(function* () {
    const sessions = yield* managedSessions(client, directory);
    const snapshots = yield* folderIO
      ? folderIO.inventory(directory)
      : client.rpc(sessionFolders).inventory({}, { location: { directory } });
    return yield* exportSessions(
      client,
      sessions.map((session) => session.id),
      { root: directory, snapshots },
    );
  });

/** Operator workflow: gate imports and preserve every existing archive/evidence file. */
export const runSessionTransfer = (
  client: Client,
  input: {
    readonly operation: "export" | "restore" | "plugins" | "shared-life";
    readonly file: string;
    readonly applicationFile?: string;
    readonly directory: string;
    readonly confirmation: string | undefined;
    readonly personas?: ReadonlyMap<string, Persona>;
  },
) =>
  Effect.gen(function* () {
    if (input.operation === "restore" || input.operation === "shared-life") {
      if (input.confirmation !== "yes")
        return yield* Effect.fail(
          new Error(
            "Restore requires CONFIRM_BOOTSTRAP_ONLY=yes; do not restore alongside live intake",
          ),
        );
    }
    if (input.operation === "shared-life") {
      if (!input.applicationFile)
        return yield* Effect.fail(
          new Error("Shared-life cutover requires an application state file"),
        );
      const applicationFile = input.applicationFile;
      const [archive, application] = yield* Effect.tryPromise({
        try: () => Promise.all([readFile(input.file, "utf8"), readFile(applicationFile, "utf8")]),
        catch: (error) => new Error(String(error)),
      });
      return yield* runSharedLifeCutover(client, {
        directory: input.directory,
        archive,
        application,
        personas: input.personas ?? new Map(),
        confirmation: input.confirmation,
      });
    }
    if (input.operation === "restore") {
      const contents = yield* Effect.tryPromise({
        try: () => readFile(input.file, "utf8"),
        catch: (error) => new Error(String(error)),
      });
      return yield* restoreSessions(client, contents, input.directory);
    }
    const contents =
      input.operation === "plugins"
        ? JSON.stringify(yield* client.plugin.list({ location: { directory: input.directory } }))
        : yield* exportLocation(client, input.directory);
    yield* Effect.tryPromise({
      try: () => writeFile(input.file, contents, { flag: "wx", mode: 0o600 }),
      catch: (error) => new Error(String(error)),
    });
    return yield* Effect.void;
  }).pipe(Effect.mapError((error) => new Error(error.message, { cause: error })));
