import { decodePersona } from "@ren-ai/personas";
import type { createPersonaStore, PersonaRecord } from "@ren-ai/personas";
import { authorPersona } from "./authoring.ts";
import type { ProfileGenerator } from "./generation.ts";

export async function characterDraft(
  seed: string,
  previous: PersonaRecord,
  generator: ProfileGenerator,
) {
  const character = await generator.character(seed);
  const form = new FormData();
  form.set("name", character.name);
  form.set("description", character.description);
  const draft = {
    ...authorPersona(form, previous),
    bio: "",
    imageUrl: "",
    published: false,
  };
  delete draft.portraits;
  return decodePersona(draft);
}

export async function profileDraft(
  persona: ReturnType<typeof authorPersona>,
  introduction: boolean,
  generator: ProfileGenerator,
  store: Awaited<ReturnType<typeof createPersonaStore>>,
) {
  const character = { name: persona.name, description: persona.description };
  const bio = introduction ? await generator.introduction(character) : persona.bio;
  const [anime, photo] = await Promise.all([
    generator.portrait(character, "anime").then(store.saveImage),
    generator.portrait(character, "photo").then(store.saveImage),
  ]);
  // Legacy clients still read imageUrl; current clients select from the complete pair.
  return decodePersona({ ...persona, bio, imageUrl: photo, portraits: { anime, photo } });
}
