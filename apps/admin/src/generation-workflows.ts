import { decodePersona, PersonaError, inspectPersona } from "@ren-ai/personas";
import type { PersonaRecord } from "@ren-ai/personas";
import { authorPersona, characterOf } from "./authoring.ts";
import type { ProfileGenerator } from "./generation.ts";
import { operation } from "./logging.ts";
import type { Draft } from "./draft.ts";
import { documentsOf } from "./draft.ts";
import { serializePersona } from "@ren-ai/personas";
import { versionedPersona } from "@ren-ai/personas";
import { improvePersona } from "./persona-improvement.ts";
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
  return { persona: decodePersona(versionedPersona(draft)), initial: character.initial };
}

export async function generateTextDraft(
  persona: ReturnType<typeof authorPersona>,
  draft: Draft,
  intent: "character" | "introduction" | "profile" | "improve" | "state" | "memory",
  generator: ProfileGenerator,
) {
  if (intent === "state" || intent === "memory") {
    const source = characterOf(persona);
    const inspected = inspectPersona(persona);
    if (inspected.status !== "current" || inspected.profileNeeded)
      throw new PersonaError(
        "invalid",
        "Persona의 형식·이름·성별·공개 자기소개를 먼저 정리해 주세요.",
      );
    const generated = await operation(`${intent}.generate`, {}, () => generator[intent](source));
    return {
      ...draft,
      preview: serializePersona(persona),
      tab: intent,
      initial: { ...draft.initial, preview: { ...documentsOf(draft), [intent]: generated } },
      imageEditing: true,
    };
  }
  if (intent === "introduction") return introductionDraft(persona, draft, generator);
  if (intent === "improve") return improvePersona(persona, draft, generator);
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
  const generated = await characterDraft(draft.seed!, persona, generator);
  const next = {
    ...draft,
    preview: serializePersona(generated.persona),
    initial: { ...draft.initial, preview: generated.initial },
    tab: "persona" as const,
    imageEditing: true,
  };
  delete next.conversion;
  delete next.characterPending;
  return next;
}
