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

export async function createPersonaStore(directory: string) {
  await mkdir(directory, { recursive: true });
  const list = async () => [...(await Effect.runPromise(readPersonas(directory))).values()];
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
  const write = async (input: PersonaRecord, create: boolean) => {
    const persona = decodePersona(input);
    if (!create) await get(persona.id);
    const temporary = join(directory, randomUUID());
    await writeFile(temporary, serializePersona(persona));
    try {
      const target = join(directory, `${persona.id}.md`);
      if (create) {
        await link(temporary, target).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "EEXIST")
            throw new PersonaError("conflict", "이미 사용 중인 ID입니다.");
          throw error;
        });
      } else await rename(temporary, target);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  };
  return {
    list,
    get,
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
        .map(({ id, name, bio, imageUrl, portraits, secondaryPortraits }) => ({
          id,
          name,
          bio,
          imageUrl,
          ...(portraits === undefined ? {} : { portraits }),
          ...(secondaryPortraits === undefined ? {} : { secondaryPortraits }),
        })),
  };
}
