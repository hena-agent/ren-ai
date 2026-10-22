import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import { parseDocument } from "yaml";
import type { folderSnapshot } from "./protocol.ts";
import { readMemoryDocuments, writeRuntime } from "./memory-files.ts";

type Snapshot = typeof folderSnapshot.Type;
const stateDocument = (snapshot: Snapshot) => {
  if (!snapshot.documents) return undefined;
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(snapshot.documents.state);
  if (!match) throw new Error("Expected initial State frontmatter");
  const document = parseDocument(match[1]!);
  if (document.errors.length) throw new Error("Invalid initial State frontmatter");
  return document;
};

// Publish complete initial scopes; interruption cannot leave a partially seeded life.
export async function initializeDirectory(target: string, run: (stage: string) => Promise<void>) {
  const stage = join(dirname(target), `.${randomUUID()}.initial`);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  try {
    await run(stage);
    await rename(stage, target);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function initializeLife(target: string, snapshot: Snapshot) {
  if (snapshot.runtime)
    return writeRuntime(target, snapshot.runtime, await readMemoryDocuments(target));
  const document = stateDocument(snapshot);
  if (!document) return;
  document.delete("affection");
  await writeFile(join(target, "STATE.md"), `---\n${document.toString()}---\n`, { mode: 0o600 });
  await writeFile(join(target, "MEMORY.md"), snapshot.documents!.memory, { mode: 0o600 });
}

export async function initializeRelationship(target: string, snapshot: Snapshot) {
  await initializeDirectory(target, async (stage) => {
    await mkdir(stage, { mode: 0o700 });
    if (snapshot.relationship)
      return writeRuntime(stage, snapshot.relationship, await readMemoryDocuments(stage));
    const affection = stateDocument(snapshot)?.get("affection");
    const state =
      affection === undefined
        ? "{}\n"
        : `affection: ${Schema.decodeUnknownSync(Schema.Number)(affection)}\n`;
    await writeFile(join(stage, "STATE.md"), `---\n${state}---\n`, { mode: 0o600 });
    await writeFile(join(stage, "MEMORY.md"), "", { mode: 0o600 });
  });
}
