import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import { folderID, sessionBinding } from "./protocol.ts";
import { personaDirectory, sessionDirectory } from "./paths.ts";

export type SessionBinding = typeof sessionBinding.Type;
const id = (value: string) => Schema.decodeUnknownSync(folderID)(value);
export const absent = (error: Error & { code?: string }) => {
  if (error.code === "ENOENT") return undefined;
  throw error;
};
const locator = Schema.Struct({ ...sessionBinding.fields, sandbox: Schema.Boolean });
const indexPath = (root: string, sessionID: string) =>
  join(root, "personas", ".bindings", `${id(sessionID)}.json`);

export async function readSessionBinding(
  directory: string,
  sessionID: string,
): Promise<SessionBinding> {
  const binding = Schema.decodeUnknownSync(Schema.fromJsonString(sessionBinding))(
    await readFile(join(directory, ".sessions", `${id(sessionID)}.json`), "utf8"),
  );
  const persona = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ id: Schema.String })),
  )(await readFile(join(directory, "persona.json"), "utf8"));
  if (persona.id !== binding.personaID) throw new Error("Session persona binding does not match");
  return binding;
}

export async function locateBinding(root: string, sessionID: string) {
  const source = await readFile(indexPath(root, sessionID), "utf8").catch(absent);
  if (source === undefined) return undefined;
  const binding = Schema.decodeUnknownSync(Schema.fromJsonString(locator))(source);
  return {
    ...binding,
    directory: binding.sandbox
      ? sessionDirectory(root, sessionID)
      : personaDirectory(root, binding.personaID),
  };
}

async function atomic(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const stage = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(stage, text, { flag: "wx", mode: 0o600 });
    await rename(stage, path);
  } finally {
    await rm(stage, { force: true });
  }
}

// Caller holds the persona-root memory lock.
export async function writeSessionBinding(
  root: string,
  directory: string,
  sessionID: string,
  binding: SessionBinding,
  sandbox = false,
) {
  const validated = Schema.decodeUnknownSync(sessionBinding)(binding);
  await atomic(indexPath(root, sessionID), JSON.stringify({ ...validated, sandbox }));
  await atomic(join(directory, ".sessions", `${id(sessionID)}.json`), JSON.stringify(validated));
}

export async function removeSessionBinding(root: string, directory: string, sessionID: string) {
  await rm(join(directory, ".sessions", `${id(sessionID)}.json`), { force: true });
  await rm(indexPath(root, sessionID), { force: true });
}
