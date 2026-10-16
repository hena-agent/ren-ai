import { Schema } from "effect";
import { LanguageBackground } from "./languages.ts";

const Text = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(2000));
const Score = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 100 }));
export const Stat = Schema.Struct({ value: Score, reason: Text });
const Line = Text.check(Schema.isPattern(/^[^\r\n]+$/));

export const CharacterSheet = Schema.Struct({
  name: Line,
  gender: Schema.Literals(["female", "male"]),
  languageBackground: Schema.optionalKey(LanguageBackground),
  appearance: Text,
  background: Text,
  dailyLife: Text,
  personality: Text,
  values: Text,
  preferences: Text,
  habits: Text,
  boundaries: Text,
  relationship: Text,
  contactExpectation: Text,
  speech: Text,
  samples: Schema.Array(Line).check(Schema.isMinLength(2), Schema.isMaxLength(3)),
  base: Schema.Struct({
    autonomy: Stat,
    sociability: Stat,
    initiative: Stat,
    sensitivity: Stat,
    expression: Stat,
    novelty: Stat,
  }),
  hidden: Schema.Array(
    Schema.Struct({ name: Line, strength: Score, context: Text, reason: Text }),
  ).check(
    Schema.isMaxLength(6),
    Schema.makeFilter(
      (traits) => new Set(traits.map((trait) => trait.name.trim())).size === traits.length,
    ),
  ),
});

const labels = {
  autonomy: "자율성",
  sociability: "사교성",
  initiative: "연락 주도성",
  sensitivity: "감수성",
  expression: "감정 표현성",
  novelty: "새로움 선호",
};

export function renderCharacterSheet(sheet: typeof CharacterSheet.Type) {
  const sections = [
    [
      "정체성·외형",
      `이름: ${sheet.name}\n성별: ${sheet.gender === "female" ? "여성" : "남성"}${sheet.languageBackground ? `\n주 사용 언어: ${sheet.languageBackground.primary}\n모국어: ${sheet.languageBackground.native.join(", ")}` : ""}\n\n${sheet.appearance}`,
    ],
    ["성장 배경", sheet.background],
    ["생활·목표", sheet.dailyLife],
    ["성격·매력·모순", sheet.personality],
    ["가치관", sheet.values],
    ["취향", sheet.preferences],
    ["습관", sheet.habits],
    ["선호·경계", sheet.boundaries],
    ["관계관", sheet.relationship],
    ["연락 기대", sheet.contactExpectation],
    ["말투", sheet.speech],
    ["문자 예시", sheet.samples.map((sample) => `- ${sample}`).join("\n")],
    [
      "기본 성향 (0–100, 고정)",
      (["autonomy", "sociability", "initiative", "sensitivity", "expression", "novelty"] as const)
        .map((key) => `- ${labels[key]}: ${sheet.base[key].value} — ${sheet.base[key].reason}`)
        .join("\n"),
    ],
    [
      "처음부터 가진 숨겨진 특성",
      sheet.hidden.length
        ? sheet.hidden
            .map(
              (trait) =>
                `### ${trait.name}\n강도: ${trait.strength}\n\n나타나는 상황: ${trait.context}\n\n이유: ${trait.reason}`,
            )
            .join("\n\n")
        : "별도로 정의한 숨겨진 특성 없음.",
    ],
  ];
  return sections.map(([title, text]) => `## ${title}\n\n${text}`).join("\n\n");
}
