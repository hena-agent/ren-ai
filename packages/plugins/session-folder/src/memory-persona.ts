import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readSessionBinding } from "./bindings.ts";
import {
  readRuntime,
  readMemoryDocuments,
  lockedMemory,
  writeScopedRuntime,
  writeRuntime,
} from "./memory-files.ts";
import { type MemoryAction, type MemoryToolName, type RuntimeSnapshot } from "./memory-model.ts";
import {
  apply,
  recall,
  searchRecords,
  stateFields,
  decodeAction,
  operationReceipt,
} from "./memory-actions.ts";
import {
  observation,
  observe,
  touched,
  conflict,
  contextDocuments,
  sourceLabel,
  observeAbsentFields,
  type Scopes,
} from "./memory-observation.ts";

const receiptKey = (sessionID: string, callID: string) => `${sessionID}:${callID}`;
const readScope = async (directory: string) =>
  (await readRuntime(directory)) ?? readMemoryDocuments(directory);

function changeState(
  scopes: Scopes,
  action: Extract<MemoryAction, { operation: "update_state" }>,
  conversationKey: string,
) {
  const { affection, ...scores } = action.input.scores;
  const { traits, languageProficiency, ...rest } = action.input;
  if (
    (Object.keys(action.input.additions).length || action.input.remove.length) &&
    !action.input.scope
  )
    throw new Error("State additions and removals require an explicit life or relationship scope");
  for (const scope of ["life", "relationship"] as const) {
    const input = {
      ...rest,
      scores: scope === "life" ? scores : affection === undefined ? {} : { affection },
      ...(scope === "life" && traits && { traits }),
      ...(scope === "life" && languageProficiency && { languageProficiency }),
      additions: action.input.scope === scope ? action.input.additions : {},
      remove: action.input.scope === scope ? action.input.remove : [],
    };
    if (stateFields(input).length)
      apply(scopes[scope], { operation: "update_state", input }, conversationKey);
  }
  return "Current State and Relationship state updated";
}

function change(
  scopes: Scopes,
  action: Exclude<MemoryAction, { operation: "dice" | "search_memory" }>,
  conversationKey: string,
  sessionID: string,
) {
  if (action.operation === "update_state") return changeState(scopes, action, conversationKey);
  const snapshot = scopes[action.input.scope];
  if (action.operation === "remember" && action.input.diceCall) {
    const diceCall = receiptKey(sessionID, action.input.diceCall);
    const receipt = scopes.life.receipts[diceCall];
    if (receipt?.operation !== "dice")
      throw new Error("Dice decision was not found in this session");
  }
  return apply(snapshot, action, conversationKey);
}

export const personaMemory = (directory: string, sessionID: string) => {
  const seen = observation(directory, sessionID);
  const saveRead = async (life: RuntimeSnapshot) => {
    const checkpoint = { ...life.observations?.[sessionID], ...Object.fromEntries(seen) };
    if (isDeepStrictEqual(life.observations?.[sessionID], checkpoint)) return;
    const previous = structuredClone(life);
    life.observations = { ...life.observations, [sessionID]: checkpoint };
    await writeRuntime(directory, life, previous);
  };
  const read = async () => {
    const binding = await readSessionBinding(directory, sessionID);
    // Recover the root WAL before reading either scope.
    const life = await readScope(directory);
    const relationship = await readScope(join(directory, "conversations", binding.conversationKey));
    return { binding, scopes: { life, relationship } };
  };
  const execute = (action: MemoryAction, callID: string, random = Math.random) =>
    lockedMemory(directory, async () => {
      const { binding, scopes } = await read();
      if (action.operation === "search_memory") {
        const records = (["life", "relationship"] as const)
          .flatMap((scope) =>
            searchRecords(scopes[scope], action.input.query).map((record) => ({ scope, record })),
          )
          .toSorted((a, b) => b.record.updatedAt.localeCompare(a.record.updatedAt))
          .slice(0, 10);
        observe(
          seen,
          scopes.life,
          records
            .filter(({ scope }) => scope === "life")
            .map(({ record }) => `longTerm.${record.id}`),
        );
        await saveRead(scopes.life);
        return JSON.stringify(
          records.map(({ scope, record }) => ({
            scope,
            ...recall(record),
            source: sourceLabel(record.source, binding.conversationKey),
          })),
        );
      }
      const id = receiptKey(sessionID, callID);
      const { inputHash, prior } = operationReceipt(scopes.life, action, id);
      if (prior !== undefined) return prior;
      if (!binding.writable)
        throw new Error("This session is read-only during replay or after its Conversation ended");
      const fields = touched(action);
      observeAbsentFields(seen, scopes.life, fields);
      const rejected = conflict(
        seen,
        scopes.life,
        fields,
        binding.conversationKey,
        sessionID,
        callID,
        action.operation,
      );
      if (rejected) {
        await saveRead(scopes.life);
        return rejected;
      }
      const previous = structuredClone(scopes);
      const output =
        action.operation === "dice"
          ? String(Math.floor(random() * 10001))
          : change(scopes, action, binding.conversationKey, sessionID);
      scopes.life.receipts = {
        ...scopes.life.receipts,
        [id]: { operation: action.operation, inputHash, output },
      };
      await writeScopedRuntime(directory, binding.conversationKey, scopes, previous);
      observe(seen, scopes.life, fields);
      if (action.operation === "remember" && action.input.scope === "life") {
        const created = scopes.life.longTerm.at(-1)!;
        observe(seen, scopes.life, [`longTerm.${created.id}`]);
      }
      return output;
    });
  return {
    // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: model-authored JSON is narrowed before accessing storage
    run: async (name: MemoryToolName, input: unknown, callID: string, _source: string) =>
      execute(decodeAction(name, input), callID),
    roll: (callID: string, _source: string, random = Math.random) =>
      execute({ operation: "dice", input: {} }, callID, random),
    // Compaction is a separate model request: it must never authorize an older turn's writes.
    context: (refresh = true) =>
      lockedMemory(directory, async () => {
        const { binding, scopes } = await read();
        const context = contextDocuments(
          scopes,
          binding.conversationKey,
          seen,
          refresh,
          scopes.life.observations?.[sessionID] ?? {},
        );
        if (refresh) await saveRead(scopes.life);
        return context;
      }),
  };
};
