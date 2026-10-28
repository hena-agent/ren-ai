import type { PersonaRecord } from "@ren-ai/personas";
import { PersonaError } from "@ren-ai/personas";
import policy from "./policy.json";
import copy from "./copy.json";

export const emptyPersona: Omit<PersonaRecord, "id"> = {
  name: "",
  description: "",
  gender: "female",
  bio: "",
  imageUrl: "",
  published: false,
  timeZone: "Asia/Seoul",
  language: "ko",
  openingLine: policy.openingLine,
  memory: policy.memory,
  prompt: "",
};

export const descriptionOf = (persona: PersonaRecord) => persona.description ?? persona.prompt;
export const characterOf = (persona: PersonaRecord) => ({
  name: persona.name,
  description: descriptionOf(persona),
  ...(persona.gender && { gender: persona.gender }),
});

export function selectedGender(form: FormData, previous: PersonaRecord) {
  const value = form.get("gender");
  if (value === null) return previous.gender;
  if (value === "female") return value;
  if (value === "male" && previous.gender === "male") return value;
  throw new PersonaError("invalid", copy.genderUnavailable);
}

export function readSeed(form: FormData) {
  const seed = form.get("seed");
  if (typeof seed !== "string" || !seed.trim())
    throw new PersonaError("invalid", copy.seedRequired);
  return seed.trim();
}

export function readIntent(form: FormData) {
  const intent = form.get("intent") ?? "save";
  if (
    intent === "save" ||
    intent === "sheet" ||
    intent === "sheets" ||
    intent === "generate" ||
    intent === "character" ||
    intent === "regenerate" ||
    intent === "delete-image" ||
    intent === "introduction" ||
    intent === "profile" ||
    intent === "inspect" ||
    intent === "improve" ||
    intent === "state" ||
    intent === "languages" ||
    intent === "memory"
  )
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
  const gender = selectedGender(form, previous);
  const changed =
    name !== previous.name ||
    description.replace(/\r\n?/g, "\n") !==
      descriptionOf(previous).replace(/\r\n?/g, "\n").trim() ||
    gender !== previous.gender;
  return {
    ...previous,
    name,
    description,
    ...(gender && { gender }),
    published: form.get("published") === "on",
    ...(changed
      ? {
          openingLine: policy.openingLine,
          memory: policy.memory,
          prompt: description,
        }
      : {}),
  };
}
