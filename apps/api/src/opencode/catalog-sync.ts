import type { OpenCode } from "@opencode/client/effect";
import { Session } from "@opencode/schema";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { decodePersona, type PersonaRecord } from "@ren-ai/personas";
import { renderSnapshot } from "@ren-ai/plugin-session-folder/files";
import { sessionFolders } from "@ren-ai/plugin-session-folder/protocol";
import { managedFolder, personaDirectory } from "@ren-ai/plugin-session-folder/paths";
import { withLifecycle } from "../conversations/lifecycle.ts";
import { managedSessions } from "./managed-sessions.ts";
import { awaitPersonaAgent } from "./agent-readiness.ts";
import { randomUUID } from "node:crypto";
import { contactLog } from "../discovery/diagnostics.ts";
import { cachedCatalog } from "../personas/cached-catalog.ts";

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

const applyPersona = Effect.fn("applyPersona")(function* (
  client: Client,
  root: string,
  folderID: string,
  persona: PersonaRecord,
  groundRules: string,
  requestId: string,
) {
  const started = performance.now();
  const snapshot = renderSnapshot(persona, groundRules);
  const existing = yield* client
    .rpc(sessionFolders)
    .read({ folderID }, { location: { directory: root } });
  if (
    existing.agent === snapshot.agent &&
    existing.rules === snapshot.rules &&
    JSON.stringify(existing.persona) === JSON.stringify(snapshot.persona)
  )
    return;
  yield* client
    .rpc(sessionFolders)
    .update({ folderID, snapshot }, { location: { directory: root } });
  yield* awaitPersonaAgent(client.agent, personaDirectory(root, persona.id), persona);
  contactLog({
    requestId,
    level: "info",
    operation: "catalog.sync",
    stage: "persona.apply",
    personaId: persona.id,
    sessionId: folderID,
    ...(persona.version !== undefined && { personaVersion: persona.version }),
    outcome: "completed",
    durationMs: performance.now() - started,
  });
});

const synchronize = Effect.fn("synchronize")(function* (
  client: Client,
  root: string,
  personas: Map<string, PersonaRecord>,
  groundRules: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const requestId = randomUUID();
  const active = yield* sql<{
    session_id: string;
    persona_id: string;
  }>`SELECT session_id, persona_id FROM conversation`;
  const updates = new Map<string, { folderID: string; persona: PersonaRecord }>();
  for (const row of active) {
    const session = yield* client.session
      .get({ sessionID: Session.ID.make(row.session_id) })
      .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(undefined)));
    if (!session) continue;
    if (session.location.directory !== personaDirectory(root, row.persona_id))
      return yield* Effect.fail(
        new Error("Migrate existing sessions to folders before starting intake"),
      );
    const missing = !personas.has(row.persona_id);
    const persona = yield* resolvePersona(client, root, row.session_id, row.persona_id, personas);
    if (!missing) updates.set(persona.id, { folderID: row.session_id, persona });
  }
  const folders = client.rpc(sessionFolders);
  const location = { location: { directory: root } };
  for (let session of yield* managedSessions(client, root)) {
    const source = managedFolder(root, session.location.directory);
    if (!source) continue;
    yield* folders.ensure({ folderID: session.id }, location);
    session = yield* client.session.get({ sessionID: session.id });
    if (!session.agent)
      return yield* Effect.fail(new Error(`Managed session ${session.id} has no catalog persona`));
    if (
      session.location.directory !== personaDirectory(root, session.agent) ||
      updates.has(session.agent)
    )
      continue;
    const missing = !personas.has(session.agent);
    const persona = yield* resolvePersona(client, root, session.id, session.agent, personas);
    if (!missing) updates.set(persona.id, { folderID: session.id, persona });
  }
  for (const { folderID, persona } of updates.values())
    yield* applyPersona(client, root, folderID, persona, groundRules, requestId);
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
  const apply = (groundRules: string, refresh: boolean) =>
    Effect.gen(function* () {
      const saved = yield* cachedCatalog(load, groundRules);
      const snapshot = yield* refresh ? saved.fresh : saved.current;
      const next = new Map(snapshot.personas);
      for (const [id, persona] of next) {
        const current = personas.get(id);
        if (current && current.description === persona.description)
          next.set(id, { ...persona, memory: current.memory });
      }
      yield* saved.synchronize(
        { ...snapshot, personas: next },
        synchronize(client, root, next, groundRules),
        true,
      );
      personas.clear();
      for (const [id, persona] of next) personas.set(id, persona);
    }).pipe(withLifecycle);
  return {
    refresh: (groundRules: string) => apply(groundRules, true),
    reconcile: (groundRules: string) => apply(groundRules, false),
  };
};
