import type { OpenCode } from "@opencode/client/effect";
import { Session } from "@opencode/schema";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { decodePersona, type PersonaRecord } from "@ren-ai/personas";
import { renderSnapshot } from "@ren-ai/plugin-session-folder/files";
import { sessionFolders } from "@ren-ai/plugin-session-folder/protocol";
import { managedFolder, sessionDirectory } from "@ren-ai/plugin-session-folder/paths";
import { withLifecycle } from "../conversations/lifecycle.ts";
import { awaitPersonaAgent } from "./agent-readiness.ts";
import { randomUUID } from "node:crypto";
import { contactLog } from "../discovery/diagnostics.ts";
import { cachedCatalog } from "../personas/cached-catalog.ts";
import { createHash } from "node:crypto";
import { claimWork, DeferredWork, workBatchSize } from "../work-budget.ts";

type Client = Effect.Success<ReturnType<typeof OpenCode.make>>;
const SyncProgress = Schema.fromJsonString(
  Schema.Struct({
    key: Schema.String,
    phase: Schema.Literals(["bound", "native", "apply"]),
    bound: Schema.Number,
    offset: Schema.Number,
    applied: Schema.String,
    cursor: Schema.optionalKey(Schema.String.pipe(Schema.brand("SessionsCursor"))),
  }),
);

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
  yield* awaitPersonaAgent(client.agent, sessionDirectory(root, folderID), persona);
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
  const [catalog] = yield* sql<{
    revision: string;
  }>`SELECT revision FROM runtime_catalog WHERE id = 1`;
  const key = createHash("sha256")
    .update(JSON.stringify([root, groundRules, catalog?.revision ?? [...personas]]))
    .digest("hex");
  const [saved] = yield* sql<{
    payload: string;
  }>`SELECT payload FROM application_checkpoint WHERE name = 'catalog.sync'`;
  const restored = saved && Schema.decodeUnknownSync(SyncProgress)(saved.payload);
  let progress: typeof SyncProgress.Type =
    restored && restored.key === key
      ? restored
      : { key, phase: "bound", bound: 0, offset: 0, applied: "" };
  const save =
    () => sql`INSERT INTO application_checkpoint (name, payload) VALUES ('catalog.sync', ${Schema.encodeSync(SyncProgress)(progress)})
    ON CONFLICT(name) DO UPDATE SET payload = excluded.payload`;
  const check = Effect.gen(function* () {
    if (yield* claimWork) return undefined;
    yield* save();
    return yield* Effect.fail(new DeferredWork());
  });
  const frozen = (id: string) =>
    sql`SELECT 1 FROM retained_session WHERE session_id = ${id} UNION SELECT 1 FROM removal WHERE session_id = ${id}
      UNION SELECT 1 FROM conversation WHERE session_id = ${id} AND ended_at IS NOT NULL`;
  const resolve = (id: string, personaID: string) =>
    Effect.gen(function* () {
      const missing = !personas.has(personaID);
      const persona = yield* resolvePersona(client, root, id, personaID, personas);
      if (missing && catalog)
        yield* sql`UPDATE runtime_catalog SET payload = ${JSON.stringify([...personas.values()])} WHERE id = 1 AND revision = ${catalog.revision}`;
      if (!missing && !(yield* frozen(id)).length)
        yield* sql`INSERT INTO catalog_plan(session_id, fingerprint, persona_id) VALUES (${id}, ${key}, ${persona.id})
      ON CONFLICT(session_id) DO UPDATE SET fingerprint = excluded.fingerprint, persona_id = excluded.persona_id
      WHERE fingerprint != excluded.fingerprint OR persona_id != excluded.persona_id`;
    });
  const limit = yield* workBatchSize;
  const scanBound = Effect.gen(function* () {
    while (progress.phase === "bound") {
      yield* check;
      const active = yield* sql<{
        id: number;
        session_id: string;
        persona_id: string;
      }>`SELECT id, session_id, persona_id FROM conversation
      WHERE id > ${progress.bound} ORDER BY id LIMIT ${limit}`;
      for (const row of active) {
        yield* check;
        const session = yield* client.session
          .get({ sessionID: Session.ID.make(row.session_id) })
          .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(undefined)));
        if (session) {
          if (session.location.directory !== sessionDirectory(root, row.session_id))
            return yield* Effect.fail(
              new Error("Migrate existing sessions to folders before starting intake"),
            );
          yield* resolve(row.session_id, row.persona_id);
        }
        progress = { ...progress, bound: row.id };
      }
      if (active.length < limit) progress = { ...progress, phase: "native" };
      yield* save();
    }
    return undefined;
  });
  yield* scanBound;
  const folders = client.rpc(sessionFolders);
  const location = { location: { directory: root } };
  const scanNative = Effect.gen(function* () {
    if (progress.phase !== "native") return undefined;
    for (;;) {
      yield* check;
      const page = yield* client.session.list({
        limit,
        cursor: progress.cursor,
      });
      for (let index = progress.offset; index < page.data.length; index++) {
        yield* check;
        let session = page.data[index]!;
        const source = managedFolder(root, session.location.directory);
        const [bound] = yield* sql<{
          persona_id: string;
        }>`SELECT persona_id FROM conversation WHERE session_id = ${session.id}`;
        if (source && !(yield* frozen(session.id)).length) {
          if (source !== session.id) {
            yield* folders.ensure({ folderID: session.id }, location);
            session = yield* client.session.get({ sessionID: session.id });
          }
          const personaID = bound?.persona_id ?? session.agent;
          if (!personaID)
            return yield* Effect.fail(
              new Error(`Managed session ${session.id} has no catalog persona`),
            );
          yield* resolve(session.id, personaID);
        }
        progress = { ...progress, offset: index + 1 };
      }
      if (!page.cursor.next) {
        progress = { ...progress, phase: "apply" };
        yield* save();
        break;
      }
      if (page.cursor.next === progress.cursor)
        return yield* Effect.fail(new Error("OpenCode session pagination did not advance"));
      progress = { ...progress, cursor: page.cursor.next, offset: 0 };
      yield* save();
    }
    return undefined;
  });
  yield* scanNative;
  const apply = Effect.gen(function* () {
    for (;;) {
      yield* check;
      const plans = yield* sql<{
        session_id: string;
        persona_id: string;
      }>`SELECT session_id, persona_id FROM catalog_plan
        WHERE fingerprint = ${key} AND session_id > ${progress.applied} ORDER BY session_id LIMIT ${limit}`;
      if (!plans.length) break;
      for (const plan of plans) {
        yield* check;
        const exists = yield* client.session
          .get({ sessionID: Session.ID.make(plan.session_id) })
          .pipe(
            Effect.as(true),
            Effect.catchTag("SessionNotFoundError", () => Effect.succeed(false)),
          );
        if (!exists) yield* sql`DELETE FROM catalog_plan WHERE session_id = ${plan.session_id}`;
        else if (!(yield* frozen(plan.session_id)).length)
          yield* applyPersona(
            client,
            root,
            plan.session_id,
            personas.get(plan.persona_id)!,
            groundRules,
            requestId,
          );
        progress = { ...progress, applied: plan.session_id };
      }
      yield* save();
    }
  });
  yield* apply;
  yield* sql`DELETE FROM application_checkpoint WHERE name = 'catalog.sync'`;
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
