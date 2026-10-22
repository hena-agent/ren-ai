import { Schema } from "effect";
import { Session } from "@opencode/schema/session";
import { SessionInbox } from "@opencode/schema/session-inbox";
import {
  folderSnapshot,
  personaFolderSnapshot,
  sessionBinding,
} from "@ren-ai/plugin-session-folder/protocol";
import { renderSnapshot } from "@ren-ai/plugin-session-folder/files";
import { runtimeFromDocuments } from "@ren-ai/plugin-session-folder/memory";
import type { Persona } from "@ren-ai/personas";
import { StateSnapshot } from "../state-snapshot.ts";

// This is the explicit, operator-confirmed ADR-0012 input, not a runtime fallback.
const legacyArchive = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    sessions: Schema.Array(
      Schema.Struct({
        info: Session.Info,
        pending: Schema.Array(SessionInbox.Info),
        folder: Schema.Struct({
          persona: folderSnapshot.fields.persona,
          agent: Schema.String,
          rules: Schema.String,
          documents: folderSnapshot.fields.documents,
          runtime: folderSnapshot.fields.runtime,
        }),
      }),
    ),
  }),
);
type LegacySession = (typeof legacyArchive.Type.sessions)[number];
type Runtime = NonNullable<typeof folderSnapshot.Type.runtime>;
type Binding = typeof sessionBinding.Type;
export interface SharedLifePlan {
  readonly folders: readonly (typeof personaFolderSnapshot.Type)[];
  readonly sessions: readonly { id: Session.ID; source: string; personaID: string }[];
}

function tableRows(snapshot: StateSnapshot, name: string) {
  const table = snapshot.tables.find((entry) => entry.name === name);
  return (table?.rows ?? []).map((row) =>
    Object.fromEntries(table!.columns.map((column, index) => [column, row[index]])),
  );
}

function applicationBindings(snapshot: StateSnapshot) {
  const result = new Map<string, Binding>();
  const conversations = tableRows(snapshot, "conversation");
  const registrations = new Set(
    conversations.map((row) => row["registration_id"]).filter((id) => typeof id === "string"),
  );
  const conversation = Schema.Struct({
    session_id: Schema.String,
    persona_id: Schema.String,
    usage_key: Schema.String,
    ended_at: Schema.NullOr(Schema.Number),
  });
  for (const data of conversations) {
    if (data["rebuilding"] === 1)
      throw new Error("Finish interrupted rebuilds before shared-life cutover");
    const row = Schema.decodeUnknownSync(conversation)(data);
    result.set(row.session_id, {
      personaID: row.persona_id,
      conversationKey: row.usage_key,
      writable: row.ended_at === null,
    });
  }
  const retained = new Set(tableRows(snapshot, "retained_session").map((row) => row["session_id"]));
  for (const data of tableRows(snapshot, "usage_session")) {
    const row = Schema.decodeUnknownSync(
      Schema.Struct({
        session_id: Schema.String,
        conversation_key: Schema.String,
        persona_id: Schema.String,
      }),
    )(data);
    if (!retained.has(row.session_id) || result.has(row.session_id)) continue;
    result.set(row.session_id, {
      personaID: row.persona_id,
      conversationKey: row.conversation_key,
      writable: false,
    });
  }
  for (const data of tableRows(snapshot, "discovery_contact")) {
    // Rebuild can replace a Conversation's session while its first-contact receipt
    // retains the original ID. The current Conversation owns this binding.
    const registration = data["registration_id"];
    if (typeof registration === "string" && registrations.has(registration)) continue;
    const row = Schema.decodeUnknownSync(
      Schema.Struct({ session_id: Schema.NullOr(Schema.String), persona_id: Schema.String }),
    )(data);
    if (row.session_id === null || result.has(row.session_id)) continue;
    result.set(row.session_id, {
      personaID: row.persona_id,
      conversationKey: row.session_id,
      writable: true,
    });
  }
  return result;
}

const stored = (entry: LegacySession): Runtime =>
  entry.folder.runtime ?? runtimeFromDocuments(entry.folder.documents);

function sharedRuntime(
  entries: readonly LegacySession[],
  bindings: ReadonlyMap<string, Binding>,
  persona: Persona,
): Runtime {
  const active = entries.filter((entry) => bindings.get(entry.info.id)?.writable);
  if (active.length > 1)
    throw new Error("Cutover needs at most one existing active Conversation per persona");
  const initial = runtimeFromDocuments(persona.initial);
  const source = active[0] ? stored(active[0]) : initial;
  const { affection: _affection, ...state } = source.state ?? {};
  // Old reasons may name a user. Preserve them only inside the Relationship scope.
  return {
    ...(Object.keys(state).length && { state }),
    additional: {},
    shortTerm: initial.shortTerm,
    longTerm: [],
    receipts: Object.fromEntries(
      entries.flatMap((entry) =>
        Object.entries(stored(entry).receipts).map(([callID, receipt]) => [
          `${entry.info.id}:${callID}`,
          receipt,
        ]),
      ),
    ),
  };
}

function relationshipRuntime(entry: LegacySession, binding: Binding): Runtime {
  const original = stored(entry);
  if (!binding.writable) return { ...original, receipts: {} };
  return {
    ...(original.state?.affection !== undefined && {
      state: { affection: original.state.affection },
    }),
    ...(original.stateChange && { stateChange: original.stateChange }),
    additional: original.additional,
    shortTerm: original.shortTerm,
    longTerm: original.longTerm,
    receipts: {},
  };
}

export function sharedLifePlan(
  archive: string,
  application: string,
  personas: ReadonlyMap<string, Persona>,
  rules: string,
): SharedLifePlan {
  let legacy: typeof legacyArchive.Type;
  let state: StateSnapshot;
  try {
    legacy = Schema.decodeUnknownSync(legacyArchive)(archive);
    state = Schema.decodeUnknownSync(Schema.fromJsonString(StateSnapshot))(application);
  } catch (cause) {
    throw new Error("Invalid private cutover archive", { cause });
  }
  const bindings = applicationBindings(state);
  const ids = new Set(legacy.sessions.map((entry) => entry.info.id));
  if (ids.size !== legacy.sessions.length)
    throw new Error("Duplicate source session in cutover archive");
  for (const sessionID of bindings.keys())
    if (!ids.has(Session.ID.make(sessionID)))
      throw new Error("Application binding is missing from the session archive");
  const groups = new Map<string, LegacySession[]>();
  for (const entry of legacy.sessions) {
    if (entry.pending.length) throw new Error("Drain queued work before shared-life cutover");
    const personaID = entry.folder.persona.id;
    if (
      entry.info.agent !== personaID ||
      (bindings.has(entry.info.id) && bindings.get(entry.info.id)!.personaID !== personaID)
    )
      throw new Error("Cutover persona binding does not match");
    if (!personas.has(personaID)) throw new Error("Cutover Catalog is missing a persona");
    if (!bindings.has(entry.info.id))
      bindings.set(entry.info.id, { personaID, conversationKey: entry.info.id, writable: false });
    const group = groups.get(personaID) ?? [];
    group.push(entry);
    groups.set(personaID, group);
  }
  return {
    sessions: legacy.sessions.map((entry) => ({
      id: entry.info.id,
      source: entry.info.location.directory,
      personaID: entry.folder.persona.id,
    })),
    folders: [...groups].map(([id, entries]) => {
      const persona = personas.get(id)!;
      const relationships: Record<string, Runtime> = {};
      for (const entry of entries) {
        const binding = bindings.get(entry.info.id)!;
        if (Object.hasOwn(relationships, binding.conversationKey))
          throw new Error("Cutover contains duplicate Relationship scopes");
        relationships[binding.conversationKey] = relationshipRuntime(entry, binding);
      }
      return {
        snapshot: {
          ...renderSnapshot(persona, rules),
          runtime: sharedRuntime(entries, bindings, persona),
        },
        bindings: Object.fromEntries(
          entries.map((entry) => [entry.info.id, bindings.get(entry.info.id)!]),
        ),
        relationships,
      };
    }),
  };
}
