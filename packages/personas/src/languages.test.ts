import { Schema } from "effect";
import { expect, test } from "vitest";
import {
  LanguageBackground,
  LanguageProficiency,
  languageBackground,
  languageSummary,
} from "./languages.ts";
import { parseInitialState, serializeInitialState } from "./initial.ts";
import { parseCharacterDescription } from "./character-format.ts";
import { renderCharacterSheet } from "./character-sheet.ts";
import { stateStatus } from "./state-diagnostics.ts";
import { sheet } from "../../../apps/admin/test/sheet.ts";
import { initialTraits } from "./publication.ts";

const background = { primary: "en", native: ["ko", "en"] };
const source = renderCharacterSheet({ ...sheet, languageBackground: background });
const state = {
  mood: 60,
  energy: 50,
  stress: 20,
  connection: 40,
  solitude: 60,
  affection: 15,
  traits: initialTraits(source),
};

test("fixed language background round-trips in Persona and cannot be supplied by the public profile", () => {
  expect(languageBackground(source)).toEqual(background);
  expect(parseCharacterDescription(source).languageBackground).toEqual(background);
  expect(languageBackground(renderCharacterSheet(sheet))).toBeUndefined();
  expect(
    languageBackground(
      `${renderCharacterSheet(sheet)}\n\n## 공개 프로필\n\nhello\n\n${source.replaceAll("## ", "### ")}`,
    ),
  ).toBeUndefined();
  expect(languageSummary(source, { ko: "fluent", en: "fluent" })).toEqual({
    ...background,
    proficiency: { ko: "fluent", en: "fluent" },
  });
  expect(languageSummary("No fixed language metadata", { ja: "beginner" })).toEqual({
    proficiency: { ja: "beginner" },
  });
  expect(languageSummary(source, undefined)).toBeUndefined();
  for (const value of [
    { ...background, primary: "english" },
    { ...background, native: [] },
    { ...background, native: ["ko", "ko"] },
  ])
    expect(() => Schema.decodeUnknownSync(LanguageBackground)(value)).toThrow(/Expected/);
  expect(() =>
    parseCharacterDescription(source.replace("주 사용 언어: en", "주 사용 언어: invalid")),
  ).toThrow(/Persona 시트/);
});

test("language proficiency is validated State data, distinct from unset and never a native promotion", () => {
  const languageProficiency = {
    ko: "fluent",
    en: "conversational",
    ja: "beginner",
    fr: "proficient",
  } as const;
  expect(
    parseInitialState(serializeInitialState({ ...state, languageProficiency })).languageProficiency,
  ).toEqual(languageProficiency);
  expect(parseInitialState(serializeInitialState(state)).languageProficiency).toBeUndefined();
  expect(Schema.decodeUnknownSync(LanguageProficiency)({})).toEqual({});
  for (const value of [{ english: "fluent" }, { ko: "native" }, { en: 100 }, { EN: "beginner" }])
    expect(() => Schema.decodeUnknownSync(LanguageProficiency)(value)).toThrow(/Expected/);
  expect(
    stateStatus(
      serializeInitialState({ ...state, languageProficiency: { ko: "fluent", en: "fluent" } }),
      source,
    ).state,
  ).toBe("valid");
  expect(stateStatus(serializeInitialState(state), source).state).toBe("valid");
  expect(
    stateStatus(
      serializeInitialState({ ...state, languageProficiency: { en: "beginner" } }),
      source,
    ).issues[0]?.message,
  ).toContain("모국어");
  expect(
    stateStatus(serializeInitialState({ ...state, languageProficiency: { ko: "fluent" } }), source)
      .state,
  ).toBe("invalid");
  expect(
    stateStatus(
      serializeInitialState(state).replace(
        "traits:",
        "languageProficiency: { ko: native }\ntraits:",
      ),
    ).issues[0]?.message,
  ).toContain("languageProficiency");
});
