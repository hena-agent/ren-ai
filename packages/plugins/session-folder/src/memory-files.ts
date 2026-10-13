import { lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import { parseConversationState } from "@ren-ai/personas";
import { stringify } from "yaml";
import { runtimeDocuments, runtimeSnapshot, type RuntimeSnapshot } from "./memory-model.ts";

const absent = (error: Error & { code?: string }) => {
  if (error.code === "ENOENT") return undefined;
  throw new Error("Conversation memory storage could not be read", { cause: error });
};
// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: validate persisted private JSON without exposing payload-bearing schema errors
export function decodeRuntime(input: unknown): RuntimeSnapshot {
  try {
    return Schema.decodeUnknownSync(runtimeSnapshot)(input, { onExcessProperty: "error" });
  } catch (cause) {
    throw new Error("Invalid Conversation memory snapshot", { cause });
  }
}
export async function readRuntime(directory: string) {
  const root = join(directory, ".memory");
  const link = await readlink(join(root, "current")).catch(absent);
  if (link === undefined) return undefined;
  const path = resolve(root, link);
  if (!path.startsWith(`${resolve(root, "versions")}${sep}`))
    throw new Error("Invalid Conversation memory revision");
  const source = await readFile(join(path, "snapshot.json"), "utf8");
  try {
    return decodeRuntime(JSON.parse(source));
  } catch (cause) {
    throw new Error("Invalid Conversation memory snapshot", { cause });
  }
}
export async function initialRuntime(directory: string): Promise<RuntimeSnapshot> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Conversation memory requires a real session directory");
  const [state, memory] = await Promise.all([
    readFile(join(directory, "STATE.md"), "utf8").catch(absent),
    readFile(join(directory, "MEMORY.md"), "utf8").catch(absent),
  ]);
  if ((state === undefined) !== (memory === undefined))
    throw new Error("Conversation requires both initial State and Memory");
  return {
    ...(state && { state: parseConversationState(state) }),
    additional: {},
    shortTerm: memory ?? "",
    longTerm: [],
    receipts: {},
  };
}
export async function writeRuntime(directory: string, snapshot: RuntimeSnapshot) {
  const root = join(directory, ".memory");
  const revision = randomUUID();
  const target = join(root, "versions", revision);
  const pointer = join(root, `${revision}.tmp`);
  await mkdir(join(target, "long-term"), { recursive: true, mode: 0o700 });
  try {
    const documents = runtimeDocuments(snapshot);
    for (const [name, text] of [
      ["snapshot.json", JSON.stringify(snapshot)],
      ["STATE.md", documents.state],
      ["MEMORY.md", documents.memory],
    ])
      await writeFile(join(target, name!), text!, { mode: 0o600, flag: "wx" });
    for (const record of snapshot.longTerm) {
      const { text, summary, ...metadata } = record;
      await writeFile(
        join(target, "long-term", `${record.id}.md`),
        `---\n${stringify(metadata)}---\n\n${record.clarity === "clear" ? text : summary}\n`,
        { mode: 0o600, flag: "wx" },
      );
    }
    await symlink(join("versions", revision), pointer);
    await rename(pointer, join(root, "current"));
    await repairRuntimeViews(directory);
  } finally {
    await rm(pointer, { force: true });
  }
}

export async function repairRuntimeViews(directory: string) {
  for (const name of ["STATE.md", "MEMORY.md", "long-term"]) {
    const temporary = join(directory, `.${randomUUID()}-${name}`);
    try {
      await symlink(join(".memory", "current", name), temporary);
      await rename(temporary, join(directory, name));
    } finally {
      await rm(temporary, { force: true });
    }
  }
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
