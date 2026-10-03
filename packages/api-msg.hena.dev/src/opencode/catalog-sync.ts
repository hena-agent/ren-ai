import { watch } from "node:fs/promises";
import type { OpenCode } from "@opencode/client/effect";
import { Session } from "@opencode/schema";
import { Effect, Schedule, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { loadPersonas, type PersonaRecord } from "@ren-ai/personas";
import { loadGroundRules, renderSnapshot } from "@ren-ai/plugin-session-folder/files";
import { sessionFolders } from "@ren-ai/plugin-session-folder/protocol";
import { managedFolder, sessionDirectory } from "@ren-ai/plugin-session-folder/paths";
import { withLifecycle } from "../conversations/lifecycle.ts";
import { managedSessions } from "./managed-sessions.ts";

type Client = Effect.Success<ReturnType<typeof OpenCode.make>>;

const synchronize = Effect.fn("synchronize")(function* (
  client: Client,
  root: string,
  personas: ReadonlyMap<string, PersonaRecord>,
) {
  const sql = yield* SqlClient.SqlClient;
  const active = yield* sql<{
    session_id: string;
    persona_id: string;
  }>`SELECT session_id, persona_id FROM conversation`;
  const frozen = new Set(
    (yield* sql<{ session_id: string }>`SELECT session_id FROM retained_session
    UNION SELECT session_id FROM removal`).map((row) => row.session_id),
  );
  const rules = yield* Effect.tryPromise(loadGroundRules);
  const updates = new Map<string, PersonaRecord>();
  for (const row of active) {
    const persona = personas.get(row.persona_id);
    if (!persona)
      return yield* Effect.fail(
        new Error(`Active persona ${row.persona_id} is missing from the catalog`),
      );
    const session = yield* client.session
      .get({ sessionID: Session.ID.make(row.session_id) })
      .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(undefined)));
    if (!session) continue;
    if (session.location.directory !== sessionDirectory(root, row.session_id))
      return yield* Effect.fail(
        new Error("Migrate existing sessions to folders before starting intake"),
      );
    if (!frozen.has(row.session_id)) updates.set(row.session_id, persona);
  }
  const folders = client.rpc(sessionFolders);
  const location = { location: { directory: root } };
  for (let session of yield* managedSessions(client, root)) {
    const source = managedFolder(root, session.location.directory);
    if (!source || frozen.has(session.id) || updates.has(session.id)) continue;
    if (source !== session.id) {
      yield* folders.ensure({ folderID: session.id }, location);
      session = yield* client.session.get({ sessionID: session.id });
    }
    const persona = personas.get(session.agent ?? "");
    if (!persona)
      return yield* Effect.fail(new Error(`Managed session ${session.id} has no catalog persona`));
    updates.set(session.id, persona);
  }
  for (const [folderID, persona] of updates)
    yield* client
      .rpc(sessionFolders)
      .update(
        { folderID, snapshot: renderSnapshot(persona, rules) },
        { location: { directory: root } },
      );
  return undefined;
});

export const syncFolders = (
  client: Client,
  root: string,
  personas: ReadonlyMap<string, PersonaRecord>,
) => withLifecycle(synchronize(client, root, personas));

export const watchCatalog = Effect.fn("watchCatalog")(function* (
  client: Client,
  root: string,
  directory: string,
  personas: Map<string, PersonaRecord>,
) {
  const refresh = Effect.gen(function* () {
    const next = yield* loadPersonas(directory);
    yield* withLifecycle(
      Effect.gen(function* () {
        yield* synchronize(client, root, next);
        personas.clear();
        for (const [id, persona] of next) personas.set(id, persona);
      }),
    );
  });
  const watchOnce = Effect.gen(function* () {
    const controller = new AbortController();
    const events = watch(directory, { signal: controller.signal });
    const changes = {
      [Symbol.asyncIterator]: () => ({
        next: () => events.next(),
        return: () => {
          // Abort before iterator.return(): it otherwise waits forever for the pending next().
          controller.abort();
          return events.return!();
        },
      }),
    };
    // Subscribe and rescan together: edits after startup sync must not wait for another edit.
    yield* Stream.fromAsyncIterable(changes, (error) => new Error(String(error))).pipe(
      Stream.merge(
        client.event
          .subscribe()
          .pipe(
            Stream.filter(
              (event) =>
                event.type === "session.created" ||
                event.type === "session.forked" ||
                event.type === "session.moved" ||
                event.type === "server.connected",
            ),
          ),
        { haltStrategy: "either" },
      ),
      Stream.merge(Stream.succeed(undefined)),
      Stream.runForEach(() => refresh),
    );
  });
  // Parser defects, failed writes and a closed watch all require a fresh subscription and rescan.
  yield* watchOnce.pipe(
    Effect.catchCause(Effect.logError),
    Effect.repeat(Schedule.spaced("1 second")),
  );
});
