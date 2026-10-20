import { Schema } from "effect";
import { splitPersonaMarkdown } from "./profile.ts";

export const LanguageCode = Schema.String.check(Schema.isPattern(/^[a-z]{2,3}(?:-[A-Z]{2})?$/));
export const Proficiency = Schema.Literals(["beginner", "conversational", "proficient", "fluent"]);
export const LanguageProficiency = Schema.Record(Schema.String, Proficiency).check(
  Schema.makeFilter((value) => Object.keys(value).every(Schema.is(LanguageCode))),
);
export const LanguageBackground = Schema.Struct({
  primary: LanguageCode,
  native: Schema.Array(LanguageCode).check(Schema.isMinLength(1), Schema.isUnique()),
});
export const PublicLanguages = Schema.Struct({
  proficiency: LanguageProficiency,
  primary: Schema.optionalKey(LanguageCode),
  native: Schema.optionalKey(Schema.Array(LanguageCode)),
});

/** Fixed language background is part of the private Persona, not mutable State. */
export function languageBackground(source: string): typeof LanguageBackground.Type | undefined {
  const match =
    /^## 정체성·외형\n+이름: *[^\n]+\n+성별: *(?:여성|남성)(?:\n+생년월일: *[^\n]+)?\n+주 사용 언어: *([^\n]+)\n+모국어: *([^\n]+)\n/m.exec(
      splitPersonaMarkdown(source)
        .privateMarkdown.split("\n")
        .map((line) => line.trim())
        .join("\n") + "\n",
    );
  if (!match) return undefined;
  return Schema.decodeUnknownSync(LanguageBackground)({
    primary: match[1],
    native: match[2]!.split(",").map((code) => code.trim()),
  });
}

export function languageSummary(
  source: string,
  proficiency: typeof LanguageProficiency.Type | undefined,
) {
  if (!proficiency) return undefined;
  const background = languageBackground(source);
  return {
    proficiency,
    ...(background && { primary: background.primary, native: background.native }),
  };
}
