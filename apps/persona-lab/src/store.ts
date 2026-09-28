import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applyTransition,
  createSession,
  emit,
  parseChanges,
  parseProposal,
  recordInput,
} from "@ren-ai/persona-engine";
import type { Event } from "@ren-ai/persona-engine";
import { personas } from "./personas.ts";
import type { Character, Decision, Entry } from "./loop.ts";

export type SessionInfo = { id: string; persona: string; events: number };
export type Saved = { persona: string; character: Character };

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: persisted JSON is revalidated on load
const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid saved record");
  return Object.fromEntries(Object.entries(value));
};

const safeId = (id: string): string => {
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error("Invalid session id");
  return id;
};

const requirePersona = (persona: string): void => {
  if (!personas[persona]) throw new Error("Unknown Persona");
};

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: persisted event is revalidated on load
const eventFrom = (value: unknown): Event => {
  const data = object(value);
  if (
    typeof data["id"] !== "string" ||
    typeof data["text"] !== "string" ||
    (data["kind"] !== "user" && data["kind"] !== "life")
  )
    throw new Error("Invalid saved input");
  return { id: data["id"], kind: data["kind"], text: data["text"] };
};

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: persisted input time is revalidated on load
const inputEntryFrom = (data: Record<string, unknown>): Extract<Entry, { type: "input" }> => {
  const event = eventFrom(data["event"]);
  const at = data["at"];
  if (at !== undefined && !Number.isFinite(at)) throw new Error("Invalid saved input time");
  return { type: "input", event, ...(at === undefined ? {} : { at: Number(at) }) };
};

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: persisted decision is revalidated on load
const decisionFrom = (value: unknown): Decision => {
  const data = object(value);
  const actions = ["send_now", "hold", "nudge", "wait_for_user", "initiate", "error"] as const;
  const requested = actions.find((action) => action === data["requested"]);
  const action = actions.find((candidate) => candidate === data["action"]);
  if (
    typeof data["id"] !== "string" ||
    typeof data["at"] !== "number" ||
    (data["trigger"] !== "input" && data["trigger"] !== "tick") ||
    !requested ||
    !action ||
    !Array.isArray(data["pendingIds"]) ||
    !data["pendingIds"].every((id: string) => typeof id === "string") ||
    (data["replyId"] !== null && typeof data["replyId"] !== "string")
  )
    throw new Error("Invalid saved decision");
  const probabilities = object(data["probabilities"]);
  if (
    Object.values(probabilities).some(
      (number) => typeof number !== "number" || number < 0 || number > 1,
    )
  )
    throw new Error("Invalid saved probabilities");
  if (data["error"] !== undefined && typeof data["error"] !== "string")
    throw new Error("Invalid saved error");
  if (
    typeof data["meaningfulAbsence"] !== "boolean" ||
    (data["window"] !== null && typeof data["window"] !== "string")
  )
    throw new Error("Invalid saved transition");
  const shifts = object(data["shifts"]);
  if (
    Object.values(shifts).some(
      (step) =>
        !["fall_clear", "fall_slight", "stable", "rise_slight", "rise_clear"].includes(
          String(step),
        ),
    )
  )
    throw new Error("Invalid saved shifts");
  const applied = parseChanges(data["applied"]);
  return {
    id: data["id"],
    at: data["at"],
    trigger: data["trigger"],
    requested,
    action,
    probabilities,
    pendingIds: data["pendingIds"].map((id: string) => id),
    shifts,
    applied,
    meaningfulAbsence: data["meaningfulAbsence"],
    window: data["window"],
    replyId: data["replyId"],
    ...(typeof data["error"] === "string" ? { error: data["error"] } : {}),
  };
};

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: persisted Character is reconstructed from validated events
export const restore = (persona: string, id: string, value: unknown): Character => {
  requirePersona(persona);
  const definition = personas[persona]!;
  const data = object(value);
  if (
    !Array.isArray(data["entries"]) ||
    !Array.isArray(data["decisions"]) ||
    typeof data["nextCheckAt"] !== "number" ||
    typeof data["offset"] !== "number" ||
    (data["lastSentAt"] !== null && typeof data["lastSentAt"] !== "number")
  )
    throw new Error("Invalid saved Character");
  let session = createSession(definition, safeId(id));
  const entries: Entry[] = [];
  for (const item of data["entries"]) {
    const entry = object(item);
    if (entry["type"] === "input") {
      const input = inputEntryFrom(entry);
      session = recordInput(session, input.event);
      entries.push(input);
    } else if (entry["type"] === "transition" && typeof entry["id"] === "string") {
      const changes = parseChanges(entry["changes"]);
      session = applyTransition(session, changes);
      entries.push({ type: "transition", id: entry["id"], changes });
    } else if (entry["type"] === "reply" && typeof entry["id"] === "string") {
      const proposal = parseProposal(entry["proposal"]);
      session = emit(session, entry["id"], proposal).state;
      entries.push({ type: "reply", id: entry["id"], proposal });
    } else if (entry["type"] === "unit" && typeof entry["id"] === "string") {
      const reason = entry["reason"];
      if (typeof reason !== "string" || !reason) throw new Error("Invalid saved entry");
      session = applyTransition(session, [{ kind: "unit", reason }]);
      entries.push({ type: "unit", id: entry["id"], reason });
    } else throw new Error("Invalid saved entry");
  }
  return {
    session,
    entries,
    decisions: data["decisions"].map(decisionFrom),
    nextCheckAt: data["nextCheckAt"],
    offset: data["offset"],
    lastSentAt: data["lastSentAt"],
  };
};

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: summarize a stored session for listing
const summarize = (id: string, value: unknown): SessionInfo | undefined => {
  const data = object(value);
  const entries = data["entries"];
  const persona = String(data["persona"]);
  if (!Array.isArray(entries) || !personas[persona]) return undefined;
  return { id, persona, events: entries.length };
};

export const createStore = (dir: string) => ({
  load: async (id: string): Promise<Saved | undefined> => {
    const file = await readFile(join(dir, `${safeId(id)}.json`)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (file === undefined) return undefined;
    // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: parse saved JSON before replay
    const value: unknown = JSON.parse(file.toString("utf8"));
    const persona = object(value)["persona"];
    if (typeof persona !== "string") throw new Error("Invalid saved Character");
    return { persona, character: restore(persona, id, value) };
  },
  save: async (persona: string, character: Character): Promise<void> => {
    requirePersona(persona);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${safeId(character.session.id)}.json`);
    const temp = `${path}.tmp`;
    await writeFile(
      temp,
      JSON.stringify({
        persona,
        entries: character.entries,
        decisions: character.decisions,
        nextCheckAt: character.nextCheckAt,
        offset: character.offset,
        lastSentAt: character.lastSentAt,
      }),
    );
    await rename(temp, path);
  },
  list: async (): Promise<SessionInfo[]> => {
    const files = await readdir(dir).then(
      (names) => names,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    if (files === null) return [];
    const sessions: SessionInfo[] = [];
    for (const name of files) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      const info = await readFile(join(dir, name))
        .then((file) => {
          // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: parse a stored session
          const value: unknown = JSON.parse(file.toString("utf8"));
          return summarize(id, value);
        })
        .catch(() => undefined);
      if (info) sessions.push(info);
    }
    return sessions;
  },
});
