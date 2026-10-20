import { Schema } from "effect";
import { expect, test } from "vitest";
import {
  LanguageBackground,
  LanguageCode,
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
import { documentStatus } from "./document-diagnostics.ts";
import { withPublicProfile } from "./profile.ts";

test("regional language tags identify one language without inventing or promoting proficiency", () => {
  expect(Schema.decodeUnknownSync(LanguageCode)("en-US")).toBe("en");
  expect(Schema.encodeSync(LanguageCode)("en")).toBe("en");
  expect(Schema.encodeSync(LanguageProficiency)({ en: "fluent" })).toEqual({ en: "fluent" });
  const regional = { primary: "en-US", native: ["en-US"] };
  const persona = renderCharacterSheet({ ...sheet, languageBackground: regional });
  expect(persona).toContain("주 사용 언어: en\n모국어: en\n\n");
  expect(languageBackground(persona.replace("모국어: en", "모국어: en-US"))).toEqual({
    primary: "en",
    native: ["en"],
  });
  expect(parseCharacterDescription(persona).languageBackground).toEqual({
    primary: "en",
    native: ["en"],
  });
  const documents = serializeInitialState({
    ...state,
    languageProficiency: { en: "fluent", ko: "fluent", ja: "proficient" },
  });
  expect(stateStatus(documents, persona.replace("모국어: en", "모국어: en-US")).state).toBe(
    "valid",
  );
  expect(
    parseInitialState(documents.replace("  en: fluent", "  en-US: fluent")).languageProficiency,
  ).toEqual({ en: "fluent", ko: "fluent", ja: "proficient" });
  expect(
    Schema.decodeUnknownSync(LanguageProficiency)({ "en-US": "fluent", en: "fluent" }),
  ).toEqual({ en: "fluent" });
  expect(() =>
    Schema.decodeUnknownSync(LanguageProficiency)({ "en-US": "beginner", en: "fluent" }),
  ).toThrow(/Expected/);
});

test("joined language fields are a Persona error with the actual bad row selected", () => {
  const malformed = source.replace(
    "주 사용 언어: en\n모국어: ko, en",
    "주 사용 언어: ko모국어: en-US",
  );
  const result = documentStatus(withPublicProfile(malformed, "Hello."), sheet.name);
  expect(result.state).toBe("invalid");
  expect(result.issues[0]?.message).toContain("별도 줄");
  expect(result.issues[0]?.line).toBe(6);
});

test("language diagnostics name the missing or nonfluent native language", () => {
  const persona = renderCharacterSheet({
    ...sheet,
    languageBackground: { primary: "en", native: ["en"] },
  });
  const missing = stateStatus(
    serializeInitialState({ ...state, languageProficiency: { ko: "fluent" } }),
    persona,
  );
  expect(missing.issues[0]?.message).toContain("en");
  const lowerSource = serializeInitialState({ ...state, languageProficiency: { en: "beginner" } });
  const lower = stateStatus(lowerSource, persona);
  expect(lower.issues[0]?.message).toContain("beginner");
  expect(lower.issues[0]?.message).toContain("모국어 en");
  expect(lowerSource.slice(lower.issues[0]!.start, lower.issues[0]!.end).trim()).toBe(
    "en: beginner",
  );
});

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
