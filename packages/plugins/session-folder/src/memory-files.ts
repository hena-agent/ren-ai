import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { runtimeDocuments, runtimeSnapshot, type RuntimeSnapshot } from "./memory-model.ts";
import { readState, readLongTerm, writeLongTerm } from "./memory-markdown.ts";
import { absent, commitMemory, recoverMemory } from "./memory-commit.ts";

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: validate imported private JSON without exposing payload-bearing schema errors
export function decodeRuntime(input: unknown): RuntimeSnapshot {
  try {
    return Schema.decodeUnknownSync(runtimeSnapshot)(input, { onExcessProperty: "error" });
  } catch (cause) {
    throw new Error("Invalid Conversation memory snapshot", { cause });
  }
}

async function longTermFiles(directory: string) {
  return (await readdir(join(directory, "long-term")).catch(absent)) ?? [];
}

export async function readMemoryDocuments(directory: string): Promise<RuntimeSnapshot> {
  const [state, memory] = await Promise.all([
    readFile(join(directory, "STATE.md"), "utf8").catch(absent),
    readFile(join(directory, "MEMORY.md"), "utf8").catch(absent),
  ]);
  if ((state === undefined) !== (memory === undefined))
    throw new Error("Conversation requires both initial State and Memory");
  const files = await longTermFiles(directory);
  return {
    additional: {},
    ...(state !== undefined && readState(state)),
    shortTerm: Schema.decodeUnknownSync(runtimeSnapshot.fields.shortTerm)(memory ?? ""),
    longTerm: await Promise.all(
      files.map(async (file) => {
        const id = file.replace(/\.md$/, "");
        Schema.decodeUnknownSync(runtimeSnapshot.fields.longTerm.value.fields.id)(id);
        if (file !== `${id}.md`) throw new Error("Expected long-term Markdown files");
        return readLongTerm(await readFile(join(directory, "long-term", file), "utf8"), id);
      }),
    ),
    receipts: {},
  };
}

export async function readRuntime(directory: string) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Conversation memory requires a real session directory");
  await recoverMemory(directory);
  const source = await readFile(join(directory, ".memory", "receipts.json"), "utf8").catch(absent);
  if (source === undefined) return undefined;
  try {
    const receipts = Schema.decodeUnknownSync(
      Schema.fromJsonString(runtimeSnapshot.fields.receipts),
    )(source, { onExcessProperty: "error" });
    return { ...(await readMemoryDocuments(directory)), receipts };
  } catch (cause) {
    throw new Error("Invalid Conversation memory files", { cause });
  }
}

function runtimeFiles(snapshot: RuntimeSnapshot) {
  const documents = runtimeDocuments(snapshot);
  return new Map([
    ["STATE.md", documents.state],
    ["MEMORY.md", documents.memory],
    ...snapshot.longTerm.map(
      (record) => [`long-term/${record.id}.md`, writeLongTerm(record)] as const,
    ),
    [".memory/receipts.json", JSON.stringify(snapshot.receipts)],
  ]);
}

export async function writeRuntime(
  directory: string,
  snapshot: RuntimeSnapshot,
  previous: RuntimeSnapshot,
) {
  const contents = runtimeFiles(snapshot);
  const originals = runtimeFiles(previous);
  const pending: { name: string; text: string | null }[] = [];
  for (const file of await longTermFiles(directory)) {
    const name = `long-term/${file}`;
    if (!contents.has(name)) pending.push({ name, text: null });
  }
  for (const [name, text] of contents) {
    const stored = await readFile(join(directory, name), "utf8").catch(absent);
    if (stored !== undefined && originals.get(name) === text) continue;
    pending.push({ name, text });
  }
  await commitMemory(directory, pending);
}

const locks = new Map<string, Promise<void>>();
export async function lockedMemory<T>(directory: string, run: () => Promise<T>): Promise<T> {
  const key = resolve(directory);
  const result = (locks.get(key) ?? Promise.resolve()).then(run);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, settled);
  try {
    return await result;
  } finally {
    if (locks.get(key) === settled) locks.delete(key);
  }
}
