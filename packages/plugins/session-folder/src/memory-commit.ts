import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Schema } from "effect";

const memoryPath = Schema.String.check(
  Schema.isPattern(
    /^(?:ADJUSTMENTS\.md|\.memory\/adjustments\.json|(?:conversations\/[a-zA-Z0-9_-]{1,200}\/)?(?:STATE\.md|MEMORY\.md|\.memory\/(?:receipts|observations)\.json|long-term\/[a-zA-Z0-9_-]{1,100}\.md))$/,
  ),
);
const changes = Schema.Array(
  Schema.Struct({ name: memoryPath, text: Schema.NullOr(Schema.String) }),
);
type Changes = typeof changes.Type;

export const absent = (error: Error & { code?: string }) => {
  if (error.code === "ENOENT") return undefined;
  throw new Error("Conversation memory storage could not be read", { cause: error });
};

async function replace(directory: string, name: string, text: string) {
  const path = join(directory, name);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(directory, ".memory", "write.tmp");
  try {
    await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function recoverMemory(directory: string) {
  await rm(join(directory, ".memory", "write.tmp"), { force: true });
  const path = join(directory, ".memory", "pending.json");
  const source = await readFile(path, "utf8").catch(absent);
  if (source === undefined) return;
  let pending: Changes;
  try {
    pending = Schema.decodeUnknownSync(Schema.fromJsonString(changes))(source, {
      onExcessProperty: "error",
    });
  } catch (cause) {
    throw new Error("Invalid pending Conversation memory write", { cause });
  }
  for (const { name, text } of pending) {
    const target = join(directory, name);
    if (text === null) await rm(target, { force: true });
    else await replace(directory, name, text);
  }
  await rm(path);
}

export async function commitMemory(directory: string, pending: Changes) {
  await mkdir(join(directory, ".memory"), { recursive: true, mode: 0o700 });
  // Only unfinished writes live here; completed operations leave no memory history.
  await replace(directory, ".memory/pending.json", JSON.stringify(pending));
  await recoverMemory(directory);
}
