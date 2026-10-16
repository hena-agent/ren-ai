import { randomUUID } from "node:crypto";
import { link, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { readPersonas } from "./files.ts";
import {
  decodePersona,
  parsePersona,
  PersonaError,
  serializePersona,
  validateID,
} from "./model.ts";
import type { PersonaRecord } from "./model.ts";
import { imageResponse, saveImage } from "./images.ts";
import type { Portrait } from "./images.ts";
import { personaImages } from "./portraits.ts";
import { inspectPersonaFiles } from "./inspection.ts";
import { legacyPersonaDraft } from "./legacy.ts";
import { readInitialFiles, writeInitialFiles, prepareInitialFiles } from "./initial-files.ts";
import type { InitialDocuments } from "./initial.ts";
import { publicationIssues } from "./publication.ts";

export async function createPersonaStore(directory: string) {
  await mkdir(directory, { recursive: true });
  const initialWrites = new Set<string>();
  const list = async () => [...(await Effect.runPromise(readPersonas(directory))).values()];
  const source = async (id: string) => {
    validateID(id);
    if (!(await readdir(directory)).includes(`${id}.md`))
      throw new PersonaError("not_found", "페르소나를 찾을 수 없습니다.");
    return readFile(join(directory, `${id}.md`), "utf8");
  };
  const get = async (id: string) => {
    validateID(id);
    const bytes = await readdir(directory)
      .then((names) => {
        const filename = `${id}.md`;
        if (!names.includes(filename))
          throw new PersonaError("not_found", "페르소나를 찾을 수 없습니다.");
        return readFile(join(directory, filename));
      })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT")
          throw new PersonaError("not_found", "페르소나를 찾을 수 없습니다.");
        throw error;
      });
    return parsePersona(id, bytes.toString());
  };
  const write = async (
    input: PersonaRecord,
    create: boolean,
    legacySource?: string,
    documents?: InitialDocuments,
  ) => {
    const persona = decodePersona(input);
    if (!create) {
      if (legacySource !== undefined) {
        if ((await source(persona.id)) !== legacySource)
          throw new PersonaError("conflict", "기존 파일이 변경되었습니다. 다시 검사해 주세요.");
      } else await get(persona.id);
    }
    const temporary = join(directory, randomUUID());
    await writeFile(temporary, serializePersona(persona));
    let staged: Awaited<ReturnType<typeof prepareInitialFiles>> | undefined;
    let installed = false;
    try {
      if (documents) {
        staged = await prepareInitialFiles(directory, persona.id, documents);
        await staged.commit();
        installed = true;
      }
      const target = join(directory, `${persona.id}.md`);
      if (create) {
        await link(temporary, target).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "EEXIST")
            throw new PersonaError("conflict", "이미 사용 중인 ID입니다.");
          throw error;
        });
      } else await rename(temporary, target);
    } catch (error) {
      const failure = new AggregateError([error], "Persona commit and initial rollback failed", {
        cause: error,
      });
      if (installed) {
        try {
          await staged!.rollback();
        } catch (rollbackError) {
          failure.errors.push(rollbackError);
          throw failure;
        }
      }
      throw error;
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  };
  return {
    list,
    inspect: () => inspectPersonaFiles(directory),
    source,
    importDraft: async (id: string) => {
      const original = await source(id);
      return { original, persona: legacyPersonaDraft(id, original) };
    },
    convertLegacy: (input: PersonaRecord, original: string) => write(input, false, original),
    get,
    save: async (
      input: PersonaRecord,
      documents: InitialDocuments,
      expected: { persona: string; initial?: InitialDocuments; legacySource?: string },
    ) => {
      validateID(input.id);
      if (initialWrites.has(input.id)) throw new PersonaError("conflict", "저장 중입니다.");
      initialWrites.add(input.id);
      try {
        if (
          JSON.stringify(await readInitialFiles(directory, input.id)) !==
          JSON.stringify(expected.initial)
        )
          throw new PersonaError(
            "conflict",
            "State 또는 Memory가 변경되었습니다. 다시 열어 주세요.",
          );
        if (
          expected.persona &&
          !expected.legacySource &&
          serializePersona(await get(input.id)) !== expected.persona
        )
          throw new PersonaError("conflict", "Persona가 변경되었습니다. 다시 열어 주세요.");
        if (input.published) {
          const issues = publicationIssues(input, documents);
          if (issues.length)
            throw new PersonaError("invalid", issues.map((issue) => issue.message).join(" "));
        }
        await write(input, !expected.persona, expected.legacySource, documents);
      } finally {
        initialWrites.delete(input.id);
      }
    },
    initial: async (id: string) => {
      await source(id);
      return readInitialFiles(directory, id);
    },
    saveInitial: async (
      id: string,
      documents: InitialDocuments,
      expected: { persona: string; initial?: InitialDocuments },
    ) => {
      validateID(id);
      if (initialWrites.has(id)) throw new PersonaError("conflict", "초기값을 저장 중입니다.");
      initialWrites.add(id);
      try {
        if (
          serializePersona(await get(id)) !== expected.persona ||
          JSON.stringify(await readInitialFiles(directory, id)) !== JSON.stringify(expected.initial)
        )
          throw new PersonaError(
            "conflict",
            "Persona 또는 초기값이 변경되었습니다. 다시 열어 주세요.",
          );
        await writeInitialFiles(directory, id, documents);
      } finally {
        initialWrites.delete(id);
      }
    },
    create: (input: PersonaRecord) => write(input, true),
    update: (input: PersonaRecord) => write(input, false),
    saveImage: (image: Portrait) => saveImage(directory, image),
    image: (filename: string) => imageResponse(directory, filename),
    publicImage: async (filename: string) => {
      if (
        !(await list()).some(
          (persona) =>
            persona.published &&
            personaImages(persona).some(
              (image) => image.imageUrl === `/discovery/images/${filename}`,
            ),
        )
      )
        return new Response(null, { status: 404 });
      return imageResponse(directory, filename);
    },
    publicList: async () =>
      (await list())
        .filter((persona) => persona.published)
        .map(({ id, name, bio, imageUrl, portraits, secondaryPortraits, publicProfile }) => ({
          id,
          name,
          bio,
          imageUrl,
          ...(portraits === undefined ? {} : { portraits }),
          ...(secondaryPortraits === undefined ? {} : { secondaryPortraits }),
          profile: projectPublicProfile(publicProfile!),
        })),
  };
}
import { projectPublicProfile } from "./profile-projection.ts";
