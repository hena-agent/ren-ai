import { createHash, randomUUID } from "node:crypto";
import { Schema } from "effect";
import { ConversationState, InitialScores } from "@ren-ai/personas";
import {
  runtimeState,
  type MemoryAction,
  type RuntimeSnapshot,
  memoryTools,
  memoryAction,
  type MemoryToolName,
} from "./memory-model.ts";

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: model-authored JSON is validated before storage access
export function decodeAction(name: MemoryToolName, input: unknown) {
  try {
    return Schema.decodeUnknownSync(memoryAction)(
      { operation: name, input },
      { onExcessProperty: "error" },
    );
  } catch (cause) {
    throw new Error("Invalid Conversation memory tool input", { cause });
  }
}

export function operationReceipt(snapshot: RuntimeSnapshot, action: MemoryAction, callID: string) {
  const inputHash = createHash("sha256").update(JSON.stringify(action.input)).digest("hex");
  const prior = snapshot.receipts[callID];
  if (prior && (prior.operation !== action.operation || prior.inputHash !== inputHash))
    throw new Error("Conversation tool replay has different input");
  return { inputHash, prior: prior?.output };
}

const provenance = (reason: string, source: string) => ({
  reason,
  source,
  at: new Date().toISOString(),
  revision: randomUUID(),
});

export function stateFields(input: typeof memoryTools.update_state.input.Type) {
  return [
    ...Object.keys(input.scores).map((key) => `scores.${key}`),
    ...Object.keys(input.traits ?? {}).map((key) => `traits.${key}`),
    ...Object.keys(input.languageProficiency ?? {}).map((key) => `languageProficiency.${key}`),
    ...[...Object.keys(input.additions), ...input.remove].map((key) => `additional.${key}`),
  ];
}

function changeState(
  snapshot: RuntimeSnapshot,
  input: typeof memoryTools.update_state.input.Type,
  source: string,
) {
  for (const [code, level] of Object.entries(input.languageProficiency ?? {}))
    if (!snapshot.state?.languageProficiency?.[code] && level !== "beginner")
      throw new Error("A newly learned language must start at beginner");
  if (Object.keys(input.scores).length || input.traits || input.languageProficiency) {
    const next = {
      ...snapshot.state,
      ...input.scores,
      ...(input.traits && { traits: { ...snapshot.state?.traits, ...input.traits } }),
      ...(input.languageProficiency && {
        languageProficiency: {
          ...snapshot.state?.languageProficiency,
          ...input.languageProficiency,
        },
      }),
    };
    try {
      const shared =
        Object.keys(input.scores).some((key) => key !== "affection") ||
        input.traits ||
        input.languageProficiency;
      snapshot.state = shared
        ? Schema.decodeUnknownSync(ConversationState)({ traits: {}, ...next })
        : Schema.decodeUnknownSync(runtimeState)(next);
    } catch (cause) {
      throw new Error("State needs all five integer scores between 0 and 100", { cause });
    }
  }
  for (const name of [...Object.keys(input.additions), ...input.remove])
    if (
      name in InitialScores.fields ||
      [
        "traits",
        "languageProficiency",
        "nativeLanguages",
        "primaryLanguage",
        "additional",
        "__proto__",
        "constructor",
        "prototype",
      ].includes(name)
    )
      throw new Error("Additional State cannot replace built-in fields");
  snapshot.additional = Object.fromEntries(
    Object.entries({ ...snapshot.additional, ...input.additions }).filter(
      ([name]) => !input.remove.includes(name),
    ),
  );
  const change = provenance(input.reason, source);
  snapshot.stateChange = change;
  snapshot.fieldChanges = {
    ...snapshot.fieldChanges,
    ...Object.fromEntries(stateFields(input).map((key) => [key, change])),
  };
  return "Current State updated";
}

function shortTerm(
  snapshot: RuntimeSnapshot,
  markdown: string,
  reason: string,
  source: string,
  forgetting = false,
) {
  snapshot.shortTerm = markdown;
  snapshot.shortTermChanges = [
    ...(forgetting ? [] : (snapshot.shortTermChanges ?? [])),
    provenance(reason, source),
  ].slice(-10);
}

function validateRecord(snapshot: RuntimeSnapshot, input: typeof memoryTools.remember.input.Type) {
  const previous = snapshot.longTerm.find((entry) => entry.id === input.id);
  if (input.id && !previous) throw new Error("Long-term memory was not found in this scope");
  if (previous && input.clarity !== "clear") {
    if (!input.shortTerm)
      throw new Error("Fading or forgetting requires updated short-term Memory");
    if (!input.diceCall) throw new Error("Fading or forgetting requires a recorded dice decision");
  }
  if (
    (input.clarity === "clear" && !input.text.trim()) ||
    (input.clarity === "faded" && !input.summary.trim())
  )
    throw new Error("Memory needs content appropriate to its clarity");
  return previous;
}

function remember(
  snapshot: RuntimeSnapshot,
  input: typeof memoryTools.remember.input.Type,
  source: string,
) {
  const previous = validateRecord(snapshot, input);
  const now = new Date().toISOString();
  const record = {
    id: previous?.id ?? randomUUID(),
    topic: input.topic,
    text: input.clarity === "clear" ? input.text : "",
    summary: input.clarity === "forgotten" ? "" : input.summary,
    clarity: input.clarity,
    reason: input.reason,
    source,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    revision: randomUUID(),
  };
  snapshot.longTerm = [...snapshot.longTerm.filter((entry) => entry.id !== record.id), record];
  if (input.shortTerm)
    shortTerm(
      snapshot,
      input.shortTerm,
      input.clarity === "clear"
        ? input.reason
        : "Memory clarity changed; use the current document.",
      source,
      input.clarity !== "clear",
    );
  return JSON.stringify({ id: record.id, clarity: record.clarity });
}

export const recall = (record: RuntimeSnapshot["longTerm"][number]) => ({
  id: record.id,
  clarity: record.clarity,
  summary: record.summary,
  source: record.source,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  ...(record.clarity === "clear" && {
    topic: record.topic,
    text: record.text,
    reason: record.reason,
  }),
});

export function searchRecords(snapshot: RuntimeSnapshot, query: string) {
  const terms = query.toLocaleLowerCase().split(/\s+/);
  return snapshot.longTerm
    .filter(
      (record) =>
        record.clarity !== "forgotten" &&
        terms.some((term) =>
          (record.clarity === "clear"
            ? `${record.topic} ${record.text} ${record.summary}`
            : record.summary
          )
            .toLocaleLowerCase()
            .includes(term),
        ),
    )
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 10);
}

export function apply(
  snapshot: RuntimeSnapshot,
  action: Exclude<MemoryAction, { readonly operation: "dice" | "search_memory" }>,
  source: string,
) {
  if (action.operation === "update_state") return changeState(snapshot, action.input, source);
  if (action.operation === "update_memory") {
    shortTerm(snapshot, action.input.markdown, action.input.reason, source);
    return "Short-term Memory updated";
  }
  return remember(snapshot, action.input, source);
}
