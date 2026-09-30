import type { OpenCode } from "@opencode/client/effect";
import type { SessionListInput } from "@opencode/client/effect/api";
import { AbsolutePath, Session } from "@opencode/schema";
import { Effect } from "effect";
import { readFile, writeFile } from "node:fs/promises";
import { exportSessions, restoreSessions } from "../opencode/transfer.ts";

type Client = Effect.Success<ReturnType<typeof OpenCode.make>>;

/** Include retained resets and child sessions, not just active application bindings. */
export const exportLocation = (client: Client, directory: string) =>
  Effect.gen(function* () {
    const ids: Array<Session.ID> = [];
    let cursor: SessionListInput["cursor"];
    const visited = new Set<string | undefined>();
    do {
      const page = yield* client.session.list({
        directory: AbsolutePath.make(directory),
        limit: 100,
        cursor,
      });
      ids.push(...page.data.map((session) => session.id));
      cursor = page.cursor.next;
      if (visited.has(cursor))
        return yield* Effect.fail(new Error("OpenCode export pagination did not advance"));
      visited.add(cursor);
    } while (cursor);
    return yield* exportSessions(client, ids);
  });

/** Operator workflow: gate imports and preserve every existing archive/evidence file. */
export const runSessionTransfer = (
  client: Client,
  input: {
    readonly operation: "export" | "restore" | "plugins";
    readonly file: string;
    readonly directory: string;
    readonly confirmation: string | undefined;
  },
) =>
  Effect.gen(function* () {
    if (input.operation === "restore") {
      if (input.confirmation !== "yes")
        return yield* Effect.fail(
          new Error(
            "Restore requires CONFIRM_BOOTSTRAP_ONLY=yes; do not restore alongside live intake",
          ),
        );
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
    return yield* Effect.tryPromise({
      try: () => writeFile(input.file, contents, { flag: "wx", mode: 0o600 }),
      catch: (error) => new Error(String(error)),
    });
  }).pipe(Effect.mapError((error) => new Error(error.message)));
