import { Schema } from "effect";
import type { PersonaRecord } from "./model.ts";
import { CharacterSheet, Stat } from "./character-sheet.ts";
import { splitPersonaMarkdown, requirePublicProfile } from "./profile.ts";
import { languageBackground } from "./languages.ts";
import { BirthDate } from "./birth-date.ts";

const descriptionVersion = 2;
const sectionKeys = {
  "성장 배경": "background",
  생활·목표: "dailyLife",
  성격·매력·모순: "personality",
  가치관: "values",
  취향: "preferences",
  습관: "habits",
  선호·경계: "boundaries",
  관계관: "relationship",
  "연락 기대": "contactExpectation",
  말투: "speech",
};
const statKeys = {
  자율성: "autonomy",
  사교성: "sociability",
  "연락 주도성": "initiative",
  감수성: "sensitivity",
  "감정 표현성": "expression",
  "새로움 선호": "novelty",
};
export const privateSectionTitles = [
  "정체성·외형",
  ...Object.keys(sectionKeys),
  "문자 예시",
  "기본 성향 (0–100, 고정)",
  "처음부터 가진 숨겨진 특성",
];

export class CharacterFormatError extends Error {
  readonly code = "invalid_description";
  constructor(
    readonly section: string,
    readonly detail: string,
    readonly excerpt = "",
  ) {
    super("현재 Persona 시트의 섹션·이름·성별·Stat·특성 형식을 확인해 주세요.");
  }
}
const invalid = (section = "", detail = "필수 섹션의 제목과 내용을 확인해 주세요.", excerpt = "") =>
  new CharacterFormatError(section, detail, excerpt);

function checked<T>(section: string, detail: string, read: () => T, excerpt = ""): T {
  try {
    return read();
  } catch {
    throw invalid(section, detail, excerpt);
  }
}

function readIdentity(section: string, source: string) {
  const identity =
    /^이름: ([^\n]+)\n성별: (여성|남성)\n생년월일: ([^\n]+)(?:\n주 사용 언어: [^\n]+\n모국어: [^\n]+)?\n\n([\s\S]+)$/.exec(
      section,
    );
  if (!identity)
    throw invalid(
      "정체성·외형",
      "이름: … / 성별: 여성 또는 남성 / 생년월일: YYYY-MM-DD 뒤에 빈 줄과 외형 설명이 필요합니다.",
    );
  const birthDate = checked(
    "정체성·외형",
    "생년월일은 YYYY-MM-DD 형식의 실제 날짜이며 미래일 수 없습니다.",
    () => Schema.decodeUnknownSync(BirthDate)(identity[3]),
    `생년월일: ${identity[3]}`,
  );
  const background = checked(
    "정체성·외형",
    "주 사용 언어와 모국어에 유효한 언어 코드를 작성해 주세요.",
    () => languageBackground(source),
  );
  return {
    name: identity[1],
    gender: identity[2] === "여성" ? "female" : "male",
    birthDate,
    appearance: identity[4],
    ...(background && { languageBackground: background }),
  };
}

export function parseCharacterDescription(source: string) {
  source = splitPersonaMarkdown(source).privateMarkdown;
  const parts = source
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/^## ([^\n]+)\n+/m);
  if (parts[0] || parts.length !== privateSectionTitles.length * 2 + 1) throw invalid();
  const sections = new Map<string, string>();
  for (let index = 1; index < parts.length; index += 2) {
    if (sections.has(parts[index]!))
      throw invalid(parts[index], "같은 섹션이 두 번 있습니다. 하나로 합쳐 주세요.");
    sections.set(parts[index]!, parts[index + 1]!.trim());
  }
  const section = (title: string) => {
    const value = sections.get(title);
    if (!value) throw invalid(title, "필수 섹션의 내용이 비어 있습니다.");
    return value;
  };
  const identity = readIdentity(section("정체성·외형"), source);
  const base = Object.fromEntries(
    section("기본 성향 (0–100, 고정)")
      .split(/^- /m)
      .filter(Boolean)
      .map((row) => {
        const match = /^([^:]+): (\d+) — ([\s\S]+)$/.exec(row.trim());
        if (!match)
          throw invalid(
            "기본 성향 (0–100, 고정)",
            "각 Stat을 “- 자율성: 85 — 근거”처럼 정수 0–100과 이유로 작성해 주세요.",
            row.trim(),
          );
        const key = Object.entries(statKeys).find(([label]) => label === match[1])?.[1];
        if (!key)
          throw invalid(
            "기본 성향 (0–100, 고정)",
            "정의된 기본 성향 6개만 작성해 주세요.",
            row.trim(),
          );
        const stat = { value: Number(match[2]), reason: match[3]!.trim() };
        checked(
          "기본 성향 (0–100, 고정)",
          "Stat은 정수 0–100이며 근거가 필요합니다.",
          () => Schema.decodeUnknownSync(Stat)(stat),
          row.trim(),
        );
        return [key, stat];
      }),
  );
  if (
    Object.keys(base).length !== 6 ||
    section("기본 성향 (0–100, 고정)").split(/^- /m).filter(Boolean).length !== 6
  )
    throw invalid("기본 성향 (0–100, 고정)", "기본 성향 6개가 각각 한 번씩 있어야 합니다.");
  const traits = section("처음부터 가진 숨겨진 특성");
  const hidden =
    traits === "별도로 정의한 숨겨진 특성 없음."
      ? []
      : traits
          .split(/^### /m)
          .filter(Boolean)
          .map((row) => {
            const match =
              /^([^\n]+)\n강도: (\d+)\n\n나타나는 상황: ([\s\S]+?)\n\n이유: ([\s\S]+)$/.exec(
                row.trim(),
              );
            if (!match)
              throw invalid(
                "처음부터 가진 숨겨진 특성",
                "특성 제목, 강도, 나타나는 상황과 이유 형식을 확인해 주세요.",
              );
            return {
              name: match[1],
              strength: Number(match[2]),
              context: match[3],
              reason: match[4],
            };
          });
  const samples = section("문자 예시").split("\n");
  if (!samples.every((line) => line.startsWith("- ")))
    throw invalid("문자 예시", "문자 예시를 “- 짧은 문자” 목록으로 작성해 주세요.");
  checked("문자 예시", "문자 예시는 2–3개의 짧은 한 줄이어야 합니다.", () =>
    Schema.decodeUnknownSync(CharacterSheet.fields.samples)(samples.map((line) => line.slice(2))),
  );
  checked(
    "처음부터 가진 숨겨진 특성",
    "특성 이름은 중복할 수 없으며 강도는 정수 0–100입니다. 최대 6개만 작성해 주세요.",
    () => Schema.decodeUnknownSync(CharacterSheet.fields.hidden)(hidden),
  );
  const textSections = Object.fromEntries(
    Object.entries(sectionKeys).map(([title, key]) => [key, section(title)]),
  );
  try {
    return Schema.decodeUnknownSync(CharacterSheet)({
      ...identity,
      ...textSections,
      samples: samples.map((line) => line.slice(2)),
      base,
      hidden,
    });
  } catch {
    throw invalid();
  }
}

export function versionedPersona(persona: PersonaRecord) {
  const record = { ...persona };
  delete record.descriptionVersion;
  try {
    const sheet = parseCharacterDescription(persona.description ?? "");
    requirePublicProfile(persona.description!);
    if (sheet.name === persona.name && (!persona.gender || sheet.gender === persona.gender))
      record.descriptionVersion = descriptionVersion;
  } catch {
    // Free-form editing remains valid; only a checked current sheet receives a version stamp.
  }
  return record;
}

export function inspectPersona(persona: PersonaRecord) {
  const profileNeeded = !splitPersonaMarkdown(persona.description ?? persona.prompt).bio;
  try {
    const sheet = parseCharacterDescription(persona.description ?? "");
    if (sheet.name !== persona.name || (persona.gender && sheet.gender !== persona.gender))
      throw invalid();
    return { status: "current" as const, message: "최신 Persona 형식입니다.", profileNeeded };
  } catch {
    return {
      status: persona.descriptionVersion === undefined ? ("convert" as const) : ("repair" as const),
      message: "현재 시트 형식으로 정리·검증이 필요합니다.",
      profileNeeded,
    };
  }
}
