import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import type { PersonaRecord } from "./model.ts";
import { PersonaError } from "./model.ts";
import { PersonaVersion } from "./versions.ts";

export async function readVersions(directory: string, id: string) {
  const path = join(directory, "versions", id);
  const files = await readdir(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return (
    await Promise.all(
      files.map(async (file) =>
        Schema.decodeUnknownSync(PersonaVersion)(
          JSON.parse(await readFile(join(path, file), "utf8")),
        ),
      ),
    )
  ).toSorted((a, b) => b.version - a.version);
}

export async function historyFor(directory: string, persona: PersonaRecord) {
  if (persona.version !== undefined) return readVersions(directory, persona.id);
  const info = await stat(join(directory, `${persona.id}.md`));
  return [{ version: 1, markdown: persona.prompt, createdAt: info.mtimeMs, restoredFrom: null }];
}

export async function writeVersionFiles(
  directory: string,
  current: PersonaRecord,
  previous?: PersonaRecord,
  restoredFrom?: number,
) {
  const created: string[] = [];
  const rollback = () => Promise.all(created.map((path) => unlink(path)));
  try {
    if (previous?.version === current.version) return { rollback };
    const path = join(directory, "versions", current.id);
    await mkdir(path, { recursive: true });
    const entries: PersonaVersion[] = [];
    if (previous && previous.version === undefined && current.version! > 1)
      entries.push({
        version: 1,
        markdown: previous.prompt,
        createdAt: Date.now(),
        restoredFrom: null,
      });
    entries.push({
      version: current.version!,
      markdown: current.prompt,
      createdAt: Date.now(),
      restoredFrom: restoredFrom ?? null,
    });
    for (const entry of entries) {
      const file = join(path, `${entry.version}.json`);
      await writeFile(file, JSON.stringify(entry), { flag: "wx", mode: 0o600 }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "EEXIST")
            throw new PersonaError("conflict", "Persona 버전이 변경되었습니다. 다시 열어 주세요.");
          throw error;
        },
      );
      created.push(file);
    }
    return { rollback };
  } catch (error) {
    const failure = new AggregateError([error], "Persona version staging and rollback failed", {
      cause: error,
    });
    try {
      await rollback();
    } catch (rollbackError) {
      failure.errors.push(rollbackError);
      throw failure;
    }
    throw error;
  }
}
