import { decodePersona } from "@ren-ai/personas";
import type { PersonaRecord } from "@ren-ai/personas";
import { authorPersona, characterOf } from "./authoring.ts";
import type { ProfileGenerator } from "./generation.ts";
import { operation } from "./logging.ts";
import type { Draft } from "./draft.ts";
import { serializePersona } from "@ren-ai/personas";

const introduce = (persona: PersonaRecord, generator: ProfileGenerator) =>
  operation("introduction.generate", {}, () => generator.introduction(characterOf(persona)));

async function introductionDraft(
  persona: PersonaRecord,
  draft: Draft,
  generator: ProfileGenerator,
) {
  const bio = await introduce(persona, generator);
  return { ...draft, preview: serializePersona(decodePersona({ ...persona, bio })) };
}

async function characterDraft(seed: string, previous: PersonaRecord, generator: ProfileGenerator) {
  const character = await operation("character.generate", {}, () =>
    previous.gender ? generator.character(seed, previous.gender) : generator.character(seed),
  );
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
  delete draft.portraitGallery;
  delete draft.secondaryPortraits;
  return decodePersona(draft);
}

export async function generateTextDraft(
  persona: ReturnType<typeof authorPersona>,
  draft: Draft,
  intent: "character" | "introduction",
  generator: ProfileGenerator,
) {
  if (intent === "introduction") return introductionDraft(persona, draft, generator);
  return {
    ...draft,
    preview: serializePersona(await characterDraft(draft.seed!, persona, generator)),
  };
}
