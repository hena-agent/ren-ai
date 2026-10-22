import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { personaMemory } from "@ren-ai/plugin-session-folder/memory";
import { writeSessionBinding } from "../../../packages/plugins/session-folder/src/bindings.ts";
import {
  lockedMemory,
  readRuntime,
  readMemoryDocuments,
  writeRuntime,
} from "../../../packages/plugins/session-folder/src/memory-files.ts";
import { runtimeSnapshot } from "../../../packages/plugins/session-folder/src/memory-model.ts";

export const emptyMemory = { additional: {}, shortTerm: "", longTerm: [], receipts: {} };

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: fixture imports exercise the same snapshot validation as native restoration
export const restoreMemory = (root: string, snapshot: unknown) =>
  lockedMemory(root, async () => {
    const previous = (await readRuntime(root)) ?? (await readMemoryDocuments(root));
    await writeRuntime(
      root,
      Schema.decodeUnknownSync(runtimeSnapshot)(snapshot, { onExcessProperty: "error" }),
      previous,
    );
  });

export async function memoryFixture(root: string) {
  await writeFile(join(root, "persona.json"), JSON.stringify({ id: "fixture" }));
  const relationship = join(root, "conversations", "fixture");
  await mkdir(relationship, { recursive: true });
  await restoreMemory(relationship, emptyMemory);
  await writeSessionBinding(root, root, "sesMemory", {
    personaID: "fixture",
    conversationKey: "fixture",
    writable: true,
  });
  const memory = personaMemory(root, "sesMemory");
  return {
    ...memory,
    // Real OpenCode reads context before each model-issued action.
    run: async (...args: Parameters<typeof memory.run>) => {
      await memory.context();
      return memory.run(...args);
    },
    restore: restoreMemory.bind(undefined, root),
  };
}

export async function withPersona(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "persona-memory-"));
  try {
    await writeFile(join(root, "persona.json"), JSON.stringify({ id: "persona1" }));
    await restoreMemory(root, {
      ...emptyMemory,
      state: { mood: 50, energy: 60, stress: 20, connection: 40, solitude: 30, traits: {} },
    });
    for (const key of ["a", "b"]) {
      const directory = join(root, "conversations", key);
      await mkdir(directory, { recursive: true });
      await restoreMemory(directory, { ...emptyMemory, state: { affection: 25 } });
      await writeSessionBinding(root, root, `ses${key}`, {
        personaID: "persona1",
        conversationKey: key,
        writable: true,
      });
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export const state = (
  scores: { energy?: number; stress?: number; affection?: number },
  reason = "A quiet evening",
) => ({ scores, additions: {}, remove: [], reason });
export const record = (scope: "life" | "relationship", text: string) => ({
  scope,
  topic: "tea",
  text,
  summary: text,
  clarity: "clear",
  reason: "Learned today",
});

export async function readers(root: string) {
  const a = personaMemory(root, "sesa");
  const b = personaMemory(root, "sesb");
  await Promise.all([a.context(), b.context()]);
  return { a, b };
}
