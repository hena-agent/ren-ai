import type { OpenCode } from "@opencode/client/effect";
import { AbsolutePath } from "@opencode/schema";
import { Effect } from "effect";
import { readFile, writeFile } from "node:fs/promises";
import { exportSessions, restoreSessions } from "../opencode/transfer.ts";
import type { Persona } from "../personas/personas.ts";
import { sessionFolders } from "@ren-ai/plugin-session-folder/protocol";
import { managedSessions } from "../opencode/managed-sessions.ts";
import { loadGroundRules, renderSnapshot } from "@ren-ai/plugin-session-folder/files";

type Client = Effect.Success<ReturnType<typeof OpenCode.make>>;

export const exportLocation = (client: Client, directory: string) =>
  managedSessions(client, directory).pipe(
    Effect.flatMap((sessions) =>
      exportSessions(
        client,
        sessions.map((session) => session.id),
      ),
    ),
  );

const migrateFolders = (
  client: Client,
  directory: string,
  personas: ReadonlyMap<string, Persona>,
) =>
  Effect.gen(function* () {
    const sessions = (yield* managedSessions(client, directory)).filter(
      (session) => session.location.directory === directory,
    );
    const active = yield* client.session.active();
    for (const session of sessions) {
      if (!personas.has(session.agent!))
        return yield* Effect.fail(new Error(`Missing persona for ${session.id}`));
      if (
        Object.hasOwn(active, session.id) ||
        (yield* client.session.inbox.list({ sessionID: session.id })).length
      )
        return yield* Effect.fail(
          new Error("Interrupt running sessions and drain queued work before moving folders"),
        );
    }
    const rules = yield* Effect.tryPromise(loadGroundRules);
    for (const session of sessions) {
      const target = yield* client
        .rpc(sessionFolders)
        .write(
          { folderID: session.id, snapshot: renderSnapshot(personas.get(session.agent!)!, rules) },
          { location: { directory } },
        );
      yield* client.session.move({ sessionID: session.id, directory: AbsolutePath.make(target) });
      yield* client.session.wait({ sessionID: session.id });
      const moved = yield* client.session.get({ sessionID: session.id });
      if (moved.location.directory !== target)
        return yield* Effect.fail(new Error(`Session ${session.id} did not move`));
    }
    return yield* Effect.void;
  });

/** Operator workflow: gate imports and preserve every existing archive/evidence file. */
export const runSessionTransfer = (
  client: Client,
  input: {
    readonly operation: "export" | "restore" | "plugins" | "folders";
    readonly file: string;
    readonly directory: string;
    readonly confirmation: string | undefined;
    readonly personas?: ReadonlyMap<string, Persona>;
  },
) =>
  Effect.gen(function* () {
    if (input.operation === "restore" || input.operation === "folders") {
      if (input.confirmation !== "yes")
        return yield* Effect.fail(
          new Error(
            "Restore requires CONFIRM_BOOTSTRAP_ONLY=yes; do not restore alongside live intake",
          ),
        );
    }
    if (input.operation === "restore") {
      const contents = yield* Effect.tryPromise({
        try: () => readFile(input.file, "utf8"),
        catch: (error) => new Error(String(error)),
      });
      return yield* restoreSessions(client, contents, input.directory, input.personas);
    }
    const contents =
      input.operation === "plugins"
        ? JSON.stringify(yield* client.plugin.list({ location: { directory: input.directory } }))
        : yield* exportLocation(client, input.directory);
    yield* Effect.tryPromise({
      try: () => writeFile(input.file, contents, { flag: "wx", mode: 0o600 }),
      catch: (error) => new Error(String(error)),
    });
    if (input.operation === "folders")
      yield* migrateFolders(client, input.directory, input.personas ?? new Map());
    return yield* Effect.void;
  }).pipe(
    Effect.mapError(
      (error) => new Error(error instanceof Error ? error.message : JSON.stringify(error)),
    ),
  );
