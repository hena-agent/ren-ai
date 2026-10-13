import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { validateInitialDocuments } from "./initial.ts";
import type { InitialDocuments } from "./initial.ts";

export async function readInitialFiles(directory: string, id: string) {
  const path = await realpath(join(directory, "initial", id)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (!path) return undefined;
  // Resolve once so a concurrent save cannot mix two revisions of the documents.
  return {
    state: await readFile(join(path, "STATE.md"), "utf8"),
    memory: await readFile(join(path, "MEMORY.md"), "utf8"),
  };
}

export async function writeInitialFiles(
  directory: string,
  id: string,
  documents: InitialDocuments,
) {
  validateInitialDocuments(documents);
  const staged = await prepareInitialFiles(directory, id, documents);
  await staged.commit();
}

export async function prepareInitialFiles(
  directory: string,
  id: string,
  documents: InitialDocuments,
) {
  if (documents.state.length > 16000 || documents.memory.length > 16000)
    throw new Error("Initial documents exceed the size limit");
  const parent = join(directory, "initial");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const revision = join(parent, `.${randomUUID()}`);
  const temporary = `${revision}.link`;
  const target = join(parent, id);
  const original = await readlink(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  await mkdir(revision, { mode: 0o700 });
  try {
    await writeFile(join(revision, "STATE.md"), documents.state, { mode: 0o600 });
    await writeFile(join(revision, "MEMORY.md"), documents.memory, { mode: 0o600 });
    await symlink(basename(revision), temporary);
  } catch (error) {
    await rm(temporary, { force: true });
    await rm(revision, { recursive: true, force: true });
    throw error;
  }
  return {
    commit: async () => {
      try {
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true });
        await rm(revision, { recursive: true, force: true });
        throw error;
      }
    },
    rollback: async () => {
      if (original === undefined) await rm(target, { force: true });
      else {
        await symlink(original, temporary);
        await rename(temporary, target);
      }
    },
  };
}
