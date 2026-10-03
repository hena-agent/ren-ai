import { decodePersona } from "@ren-ai/personas";
import type { createPersonaStore, PersonaRecord } from "@ren-ai/personas";
import { authorPersona } from "./authoring.ts";
import type { ProfileGenerator } from "./generation.ts";
import { operation } from "./logging.ts";

export async function characterDraft(
  seed: string,
  previous: PersonaRecord,
  generator: ProfileGenerator,
) {
  const character = await operation("character.generate", {}, () => generator.character(seed));
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
  instructions: string | undefined,
) {
  const character = { name: persona.name, description: persona.description };
  const bio = introduction
    ? await operation("introduction.generate", {}, () => generator.introduction(character))
    : persona.bio;
  const portrait = async (style: "anime" | "photo") => {
    const image = await operation("portrait.generate", { style }, () =>
      instructions
        ? generator.portrait(character, style, instructions)
        : generator.portrait(character, style),
    );
    return operation("image.save", { style }, () => store.saveImage(image));
  };
  const [anime, photo] = await Promise.all([portrait("anime"), portrait("photo")]);
  // Legacy clients still read imageUrl; current clients select from the complete pair.
  return decodePersona({ ...persona, bio, imageUrl: photo, portraits: { anime, photo } });
}
