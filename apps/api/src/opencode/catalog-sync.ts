import type { OpenCode } from "@opencode/client/effect";
import { Session } from "@opencode/schema";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { decodePersona, type PersonaRecord } from "@ren-ai/personas";
import { renderSnapshot } from "@ren-ai/plugin-session-folder/files";
import { sessionFolders } from "@ren-ai/plugin-session-folder/protocol";
import { managedFolder, sessionDirectory } from "@ren-ai/plugin-session-folder/paths";
import { withLifecycle } from "../conversations/lifecycle.ts";
import { managedSessions } from "./managed-sessions.ts";

type Client = Effect.Success<ReturnType<typeof OpenCode.make>>;

const resolvePersona = Effect.fn("resolvePersona")(function* (
  client: Client,
  root: string,
  folderID: string,
  personaID: string,
  personas: Map<string, PersonaRecord>,
) {
  const current = personas.get(personaID);
  if (current) return current;
  const snapshot = yield* client
    .rpc(sessionFolders)
    .read({ folderID }, { location: { directory: root } });
  if (snapshot.persona.id !== personaID)
    return yield* Effect.fail(new Error("Session snapshot persona ID does not match Conversation"));
  const preserved = yield* Effect.try(() =>
    decodePersona({
      ...snapshot.persona,
      name: personaID,
      bio: "",
      imageUrl: "",
      published: false,
    }),
  );
  personas.set(personaID, preserved);
  yield* Effect.logError({
    operation: "catalog.sync",
    stage: "persona.missing",
    personaId: personaID,
    sessionId: folderID,
    outcome: "preserved_snapshot",
  });
  return preserved;
});

const synchronize = Effect.fn("synchronize")(function* (
  client: Client,
  root: string,
  personas: Map<string, PersonaRecord>,
  groundRules: string,
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
  const updates = new Map<string, PersonaRecord>();
  for (const row of active) {
    const session = yield* client.session
      .get({ sessionID: Session.ID.make(row.session_id) })
      .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(undefined)));
    if (!session) continue;
    if (session.location.directory !== sessionDirectory(root, row.session_id))
      return yield* Effect.fail(
        new Error("Migrate existing sessions to folders before starting intake"),
      );
    const missing = !personas.has(row.persona_id);
    const persona = yield* resolvePersona(client, root, row.session_id, row.persona_id, personas);
    if (!frozen.has(row.session_id) && !missing) updates.set(row.session_id, persona);
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
    if (!session.agent)
      return yield* Effect.fail(new Error(`Managed session ${session.id} has no catalog persona`));
    const missing = !personas.has(session.agent);
    const persona = yield* resolvePersona(client, root, session.id, session.agent, personas);
    if (!missing) updates.set(session.id, persona);
  }
  for (const [folderID, persona] of updates)
    yield* client
      .rpc(sessionFolders)
      .update(
        { folderID, snapshot: renderSnapshot(persona, groundRules) },
        { location: { directory: root } },
      );
  return undefined;
});

export const syncFolders = (
  client: Client,
  root: string,
  personas: Map<string, PersonaRecord>,
  groundRules: string,
) => withLifecycle(synchronize(client, root, personas, groundRules));

export const catalogRefresher = (
  client: Client,
  root: string,
  load: () => Promise<{ revision: string; personas: Map<string, PersonaRecord> }>,
  personas: Map<string, PersonaRecord>,
) => {
  let revision: string | undefined;
  return {
    refresh: Effect.fn("refreshCatalog")(function* (groundRules: string) {
      const snapshot = yield* Effect.tryPromise(load);
      const changed = snapshot.revision !== revision;
      const next = new Map(snapshot.personas);
      for (const [id, persona] of next) {
        const current = personas.get(id);
        if (current && current.description === persona.description)
          next.set(id, { ...persona, memory: current.memory });
      }
      yield* synchronize(client, root, next, groundRules);
      if (!changed) return;
      personas.clear();
      for (const [id, persona] of next) personas.set(id, persona);
      revision = snapshot.revision;
    }, withLifecycle),
  };
};
