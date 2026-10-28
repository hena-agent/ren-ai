import { expect, test } from "vitest";
import { decodePersona } from "./model.ts";
import { projectPersona, readProjection } from "./projection.ts";
import { renderCharacterSheet } from "./character-sheet.ts";
import { initialTraits } from "./publication.ts";
import { serializeInitialState } from "./initial.ts";
import { withPublicProfile } from "./profile.ts";
import { projectPublicProfile } from "./profile-projection.ts";
import { sheet } from "../../../apps/admin/test/sheet.ts";

const character = renderCharacterSheet({
  ...sheet,
  languageBackground: { primary: "ko", native: ["ko"] },
});
const persona = (
  published: boolean,
  profile = "천천히 알아가요.\n\n### 좋아하는 것\n\n- 사진 산책",
) =>
  decodePersona({
    id: "harin",
    name: sheet.name,
    bio: "",
    imageUrl: "",
    published,
    timeZone: "Asia/Seoul",
    language: "ko",
    openingLine: "안녕하세요",
    memory: "기억해",
    prompt: withPublicProfile(character, profile),
  });
const state = serializeInitialState({
  mood: 60,
  energy: 50,
  stress: 20,
  connection: 40,
  solitude: 60,
  affection: 15,
  traits: initialTraits(character),
  languageProficiency: { ko: "fluent" },
});

test("drafts store only their split profile, while published Personas store what Discovery reads", () => {
  expect(readProjection(projectPersona(persona(false), state))).toEqual({
    bio: "천천히 알아가요.",
    publicProfile: "천천히 알아가요.\n\n### 좋아하는 것\n\n- 사진 산책",
  });
  // Exactly what the public list used to derive from her Markdown on every read.
  expect(readProjection(projectPersona(persona(true), state))).toEqual({
    bio: "천천히 알아가요.",
    publicProfile: "천천히 알아가요.\n\n### 좋아하는 것\n\n- 사진 산책",
    public: {
      profile: projectPublicProfile("천천히 알아가요.\n\n### 좋아하는 것\n\n- 사진 산책"),
      birthDate: sheet.birthDate,
      languages: { primary: "ko", native: ["ko"], proficiency: { ko: "fluent" } },
    },
  });
  expect(readProjection(projectPersona(persona(true), "")).public).not.toHaveProperty("languages");
});

test("a record carrying only her prompt projects exactly as her description does", () => {
  const { description: _description, ...prompted } = persona(true);
  expect(projectPersona(prompted, state)).toBe(projectPersona(persona(true), state));
  const { publicProfile: _profile, ...unsplit } = persona(false);
  expect(readProjection(projectPersona(unsplit, state)).publicProfile).toBe("");
});

test("a public profile Discovery would reject fails its save instead of every visitor's list", () => {
  const unreadable = { ...persona(false), published: true, publicProfile: "" };
  expect(() => projectPersona(unreadable, state)).toThrow(/introduction/);
  const { publicProfile: _missing, ...unsplit } = unreadable;
  expect(() => projectPersona(unsplit, state)).toThrow(/introduction/);
  expect(() => readProjection("")).toThrow("Expected a valid JSON string");
  expect(() => readProjection('{"bio":"","publicProfile":"","public":{}}')).toThrow("profile");
});
