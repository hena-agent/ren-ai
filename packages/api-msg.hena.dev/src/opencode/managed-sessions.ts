import type { OpenCode } from "@opencode/client/effect";
import type { SessionListInput } from "@opencode/client/effect/api";
import type { Session } from "@opencode/schema";
import { managedFolder } from "@ren-ai/plugin-session-folder/paths";
import { Effect } from "effect";

/** Include legacy root sessions and native descendants, not only application bindings. */
export const managedSessions = (
  client: Effect.Success<ReturnType<typeof OpenCode.make>>,
  directory: string,
) =>
  Effect.gen(function* () {
    const sessions: Array<Session.Info> = [];
    let cursor: SessionListInput["cursor"];
    const visited = new Set<string | undefined>();
    do {
      const page = yield* client.session.list({ limit: 100, cursor });
      sessions.push(
        ...page.data.filter(
          (session) =>
            session.location.directory === directory ||
            managedFolder(directory, session.location.directory) !== undefined,
        ),
      );
      cursor = page.cursor.next;
      if (visited.has(cursor))
        return yield* Effect.fail(new Error("OpenCode session pagination did not advance"));
      visited.add(cursor);
    } while (cursor);
    return sessions;
  });
