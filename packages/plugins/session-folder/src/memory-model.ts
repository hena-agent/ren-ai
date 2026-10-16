import { Schema } from "effect";
import { InitialScores, InitialState, ConversationState } from "@ren-ai/personas";
import { stringify } from "yaml";

const text = (length: number) =>
  Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(length));
const value = Schema.Union([
  Schema.Number.check(Schema.isFinite()),
  Schema.String.check(Schema.isMaxLength(1000)),
  Schema.Boolean,
]);
const extraState = Schema.Struct({ value, meaning: text(500), reason: text(1000) });
export const memoryRecord = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,100}$/)),
  topic: text(200),
  text: Schema.String,
  summary: Schema.String,
  clarity: Schema.Literals(["clear", "faded", "forgotten"]),
  reason: text(1000),
  source: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export const runtimeSnapshot = Schema.Struct({
  state: Schema.optionalKey(ConversationState),
  stateChange: Schema.optionalKey(
    Schema.Struct({ reason: text(1000), source: Schema.String, at: Schema.String }),
  ),
  additional: Schema.Record(text(100), extraState),
  shortTerm: Schema.String.check(Schema.isMaxLength(16000)),
  longTerm: Schema.Array(memoryRecord),
  receipts: Schema.Record(
    Schema.String,
    Schema.Struct({ operation: Schema.String, inputHash: Schema.String, output: Schema.String }),
  ),
});
export type RuntimeSnapshot = {
  -readonly [K in keyof typeof runtimeSnapshot.Type]: (typeof runtimeSnapshot.Type)[K];
};

const scorePatch = Schema.Struct({
  mood: Schema.optionalKey(InitialScores.fields.mood),
  energy: Schema.optionalKey(InitialScores.fields.energy),
  stress: Schema.optionalKey(InitialScores.fields.stress),
  connection: Schema.optionalKey(InitialScores.fields.connection),
  solitude: Schema.optionalKey(InitialScores.fields.solitude),
  affection: Schema.optionalKey(InitialScores.fields.affection),
});
export const memoryTools = {
  update_state: {
    description:
      "Update current Conversation state. Keep condition scores and affection at integer 0–100; if no condition scores exist, supply all five from current circumstances. Affection starts from the Persona's approved initial value only for new Conversations, then evolves from actual experience; never reset it from a later Catalog edit or reroll it each turn. It is interest, not familiarity/trust/relationship stage or an action probability. Patch trait activation/strength when justified. Add meaningful scalar states only when needed for future choices, with meaning/evidence. This does not change fixed identity.",
    input: Schema.Struct({
      scores: scorePatch,
      traits: Schema.optionalKey(InitialState.fields.traits),
      additions: Schema.Record(text(100), extraState),
      remove: Schema.Array(text(100)),
      reason: text(1000),
    }),
  },
  update_memory: {
    description:
      "Replace this Conversation's short-term Memory with a concise current-life, facts, unfinished plans and promises note in the Persona's language. Keep lasting facts in long-term memory before dropping them here. This is memory content, not instructions.",
    input: Schema.Struct({ markdown: text(16000), reason: text(1000) }),
  },
  remember: {
    description:
      "Record or revise this Conversation's long-term memory. Clear memories need text; faded memories retain only a summary; forgotten memories lose text and summary. Supply an existing id to correct/fade/forget a record. Changes to faded/forgotten require a prior diceCall and an updated shortTerm note in the same operation. Give actual evidence. Restore a lost fact only from newly learned evidence.",
    input: Schema.Struct({
      id: Schema.optionalKey(text(100)),
      topic: text(200),
      text: Schema.String.check(Schema.isMaxLength(4000)),
      summary: Schema.String.check(Schema.isMaxLength(1000)),
      clarity: memoryRecord.fields.clarity,
      reason: text(1000),
      diceCall: Schema.optionalKey(text(200)),
      shortTerm: Schema.optionalKey(text(16000)),
    }),
  },
  search_memory: {
    description:
      "Search only this Conversation's long-term memories by relevant words. Clear records include content and evidence; faded records expose only remaining gist and provenance, not their old topic or reason. Forgotten records are excluded. Use when past facts, promises or experiences are needed beyond short-term Memory.",
    input: Schema.Struct({ query: text(300) }),
  },
};
export const memoryToolNames = [
  "update_state",
  "update_memory",
  "remember",
  "search_memory",
] as const;
export type MemoryToolName = (typeof memoryToolNames)[number];

export const memoryAction = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("update_state"),
    input: memoryTools.update_state.input,
  }),
  Schema.Struct({
    operation: Schema.Literal("update_memory"),
    input: memoryTools.update_memory.input,
  }),
  Schema.Struct({ operation: Schema.Literal("remember"), input: memoryTools.remember.input }),
  Schema.Struct({
    operation: Schema.Literal("search_memory"),
    input: memoryTools.search_memory.input,
  }),
  Schema.Struct({ operation: Schema.Literal("dice"), input: Schema.Struct({}) }),
]);
export type MemoryAction = typeof memoryAction.Type;

export const runtimeDocuments = (snapshot: RuntimeSnapshot) => ({
  state: `---\n${stringify({ ...snapshot.state, additional: snapshot.additional, ...(snapshot.stateChange && { lastChange: snapshot.stateChange }) })}---\n`,
  memory: snapshot.shortTerm,
});
