import type { PersonaRecord } from "@ren-ai/personas";
import { PersonaError } from "@ren-ai/personas";
import policy from "./policy.json";
import copy from "./copy.json";

export const emptyPersona: Omit<PersonaRecord, "id"> = {
  name: "",
  description: "",
  bio: "",
  imageUrl: "",
  published: false,
  timeZone: "Asia/Seoul",
  language: "ko",
  openingLine: policy.openingLine,
  memory: policy.memory,
  prompt: policy.conversation,
};

export const descriptionOf = (persona: PersonaRecord) => persona.description ?? persona.prompt;

export function readIntent(form: FormData) {
  const intent = form.get("intent") ?? "save";
  if (intent === "save" || intent === "generate" || intent === "portrait" || intent === "character")
    return intent;
  throw new PersonaError("invalid", copy.formError);
}

export function readPortraitInstructions(form: FormData) {
  const value = form.get("portraitInstructions") ?? "";
  if (typeof value !== "string") throw new PersonaError("invalid", copy.formError);
  return value.trim();
}

export function authorPersona(form: FormData, previous: PersonaRecord) {
  const read = (field: string) => {
    const value = form.get(field);
    if (typeof value !== "string") throw new PersonaError("invalid", copy.formError);
    return value.trim();
  };
  const name = read("name");
  const description = read("description");
  const changed = name !== previous.name || description !== descriptionOf(previous);
  return {
    ...previous,
    name,
    description,
    published: form.get("published") === "on",
    ...(changed
      ? {
          openingLine: policy.openingLine,
          memory: policy.memory,
          prompt: `${policy.conversation}\n\n이름: ${name}\n언어: ${previous.language}\n\n${description}`,
        }
      : {}),
  };
}

export function requireMatchingProfile(persona: PersonaRecord, previous: PersonaRecord) {
  if (
    (previous.bio || previous.imageUrl) &&
    (persona.name !== previous.name || descriptionOf(persona) !== descriptionOf(previous))
  )
    throw new PersonaError("invalid", copy.regenerateRequired);
}

export function needsIntroduction(persona: PersonaRecord, previous: PersonaRecord) {
  return (
    !previous.bio ||
    !previous.imageUrl ||
    persona.name !== previous.name ||
    descriptionOf(persona) !== descriptionOf(previous)
  );
}
