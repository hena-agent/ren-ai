import { decodePersona } from "@ren-ai/personas";
import type { PersonaRecord } from "@ren-ai/personas";
import { authorPersona, characterOf, emptyPersona } from "./authoring.ts";
import type { ProfileGenerator } from "./generation.ts";
import { GenerationError, operation } from "./logging.ts";
import type { Draft } from "./draft.ts";
import { previewOf } from "./draft.ts";
import { serializePersona } from "@ren-ai/personas";
import { parseCharacterDescription, versionedPersona } from "./character-format.ts";
import { renderCharacterSheet } from "./character-sheet.ts";
import {
  splitPersonaMarkdown,
  withPublicProfile,
  requirePublicProfile,
} from "@ren-ai/personas/profile";

const introduce = (persona: PersonaRecord, generator: ProfileGenerator) =>
  operation("introduction.generate", {}, () => generator.introduction(characterOf(persona)));

async function introductionDraft(
  persona: PersonaRecord,
  draft: Draft,
  generator: ProfileGenerator,
) {
  const bio = await introduce(persona, generator);
  const profile = splitPersonaMarkdown(persona.description!).publicMarkdown;
  const paragraphEnd = profile.indexOf("\n\n");
  const description = withPublicProfile(
    persona.description!,
    `${bio}${paragraphEnd < 0 ? "" : profile.slice(paragraphEnd)}`,
  );
  return { ...draft, preview: serializePersona(decodePersona({ ...persona, description })) };
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
    imageUrl: "",
    published: false,
  };
  delete draft.portraits;
  delete draft.portraitGallery;
  delete draft.secondaryPortraits;
  return decodePersona(versionedPersona(draft));
}

async function conversionDraft(persona: PersonaRecord, draft: Draft, generator: ProfileGenerator) {
  let description: string;
  let additions: readonly string[];
  try {
    const sheet = parseCharacterDescription(persona.description!);
    if (sheet.name !== persona.name || (persona.gender && sheet.gender !== persona.gender))
      throw new GenerationError("Description identity does not match persona", {
        code: "description_identity_mismatch",
      });
    const profile = requirePublicProfile(persona.description!).publicMarkdown;
    description = withPublicProfile(renderCharacterSheet(sheet), profile);
    additions = [];
  } catch {
    const converted = await operation("character.convert", {}, async () => {
      const result = await generator.convert(characterOf(persona));
      const sheet = parseCharacterDescription(result.description);
      requirePublicProfile(result.description);
      if (
        result.name !== persona.name ||
        sheet.name !== persona.name ||
        (persona.gender && sheet.gender !== persona.gender)
      )
        throw new GenerationError("Conversion changed persona identity", {
          code: "conversion_identity_mismatch",
        });
      return result;
    });
    description = converted.description;
    additions = converted.additions;
  }
  const form = new FormData();
  form.set("name", persona.name);
  form.set("description", description);
  if (persona.published) form.set("published", "on");
  const converted = versionedPersona(authorPersona(form, persona));
  return {
    ...draft,
    preview: serializePersona(converted),
    conversion:
      persona.description === previewOf(draft, emptyPersona).description && draft.conversion
        ? draft.conversion
        : { source: persona.description!, additions },
    imageEditing: true,
  };
}

export async function generateTextDraft(
  persona: ReturnType<typeof authorPersona>,
  draft: Draft,
  intent: "character" | "introduction" | "profile" | "convert",
  generator: ProfileGenerator,
) {
  if (intent === "introduction") return introductionDraft(persona, draft, generator);
  if (intent === "convert") return conversionDraft(persona, draft, generator);
  if (intent === "profile") {
    const publicMarkdown = await operation("profile.generate", {}, () =>
      generator.profile(characterOf(persona)),
    );
    const description = withPublicProfile(persona.description, publicMarkdown);
    requirePublicProfile(description);
    return {
      ...draft,
      preview: serializePersona(decodePersona({ ...persona, description })),
    };
  }
  const next = {
    ...draft,
    preview: serializePersona(await characterDraft(draft.seed!, persona, generator)),
  };
  delete next.conversion;
  return next;
}
