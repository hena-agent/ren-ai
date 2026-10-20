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
import { inspectPersonaFiles } from "./inspection.ts";
import { legacyPersonaDraft } from "./legacy.ts";
import { readInitialFiles, writeInitialFiles, prepareInitialFiles } from "./initial-files.ts";
import type { InitialDocuments } from "./initial.ts";
import { publicationIssues } from "./publication.ts";
import { parseInitialState } from "./initial.ts";
import { languageSummary } from "./languages.ts";
import { ageOn, birthDateOf } from "./birth-date.ts";
import { nextPersonaVersion, requireVersion } from "./versions.ts";
import type { SaveSnapshot } from "./versions.ts";
import { historyFor, readVersions, writeVersionFiles } from "./version-files.ts";
import { identitySheetFiles } from "./identity-sheets.ts";
import { fileListing } from "./file-listing.ts";
import type { PersonaQuery } from "./listing.ts";

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
  const previousForWrite = async (input: PersonaRecord, create: boolean, legacySource?: string) => {
    if (create) {
      if ((await readdir(directory)).includes(`${input.id}.md`))
        throw new PersonaError("conflict", "이미 사용 중인 ID입니다.");
      const [last] = await readVersions(directory, input.id);
      return last
        ? { ...input, version: last.version, description: last.markdown, prompt: last.markdown }
        : undefined;
    }
    if (legacySource === undefined) return get(input.id);
    if ((await source(input.id)) !== legacySource)
      throw new PersonaError("conflict", "기존 파일이 변경되었습니다. 다시 검사해 주세요.");
    return legacyPersonaDraft(input.id, legacySource);
  };
  const write = async (
    input: PersonaRecord,
    create: boolean,
    legacySource?: string,
    documents?: InitialDocuments,
    restoredFrom?: number,
  ) => {
    const candidate = decodePersona(input);
    const previous = await previousForWrite(candidate, create, legacySource);
    const version = nextPersonaVersion(previous, candidate.prompt, restoredFrom);
    const markdown = previous?.version === version ? previous.prompt : candidate.prompt;
    const persona = { ...candidate, version, description: markdown, prompt: markdown };
    const temporary = join(directory, randomUUID());
    await writeFile(temporary, serializePersona(persona));
    let staged: Awaited<ReturnType<typeof prepareInitialFiles>> | undefined;
    let installed = false;
    let history: Awaited<ReturnType<typeof writeVersionFiles>> | undefined;
    try {
      if (documents) {
        staged = await prepareInitialFiles(directory, persona.id, documents);
        await staged.commit();
        installed = true;
      }
      history = await writeVersionFiles(directory, persona, previous, restoredFrom);
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
      for (const rollback of [history?.rollback, installed ? staged!.rollback : undefined]) {
        try {
          await rollback?.();
        } catch (rollbackError) {
          failure.errors.push(rollbackError);
        }
      }
      if (failure.errors.length > 1) throw failure;
      throw error;
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    return persona;
  };
  const history = async (id: string) => {
    const current = await get(id);
    return (await historyFor(directory, current)).filter(
      (entry) => entry.version <= (current.version ?? entry.version),
    );
  };
  return {
    ...identitySheetFiles(directory),
    list,
    browse: async (query: PersonaQuery) => fileListing(directory, await list(), query),
    inspect: () => inspectPersonaFiles(directory),
    source,
    importDraft: async (id: string) => {
      const original = await source(id);
      return { original, persona: legacyPersonaDraft(id, original) };
    },
    convertLegacy: (input: PersonaRecord, original: string) => write(input, false, original),
    get,
    versions: async (id: string) =>
      (await history(id)).map(({ markdown: _markdown, ...summary }) => summary),
    version: async (id: string, version: number) => requireVersion(await history(id), version),
    save: async (input: PersonaRecord, documents: InitialDocuments, expected: SaveSnapshot) => {
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
        return await write(
          input,
          !expected.persona,
          expected.legacySource,
          documents,
          expected.restoredFrom,
        );
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
    publicList: async () =>
      Promise.all(
        (await list())
          .filter((persona) => persona.published)
          .map(
            async ({
              id,
              name,
              bio,
              imageUrl,
              portraits,
              secondaryPortraits,
              publicProfile,
              prompt,
            }) => {
              const initial = await readInitialFiles(directory, id);
              const birthDate = birthDateOf(prompt);
              const languages = initial?.state.trim()
                ? languageSummary(prompt, parseInitialState(initial.state).languageProficiency)
                : undefined;
              return {
                id,
                name,
                ...(birthDate && { age: ageOn(birthDate) }),
                bio,
                imageUrl,
                ...(portraits === undefined ? {} : { portraits }),
                ...(secondaryPortraits === undefined ? {} : { secondaryPortraits }),
                profile: projectPublicProfile(publicProfile!),
                ...(languages && { languages }),
              };
            },
          ),
      ),
  };
}
import { projectPublicProfile } from "./profile-projection.ts";
