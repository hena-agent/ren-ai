import { expect, test } from "vitest";
import { sheet } from "../test/character.ts";
import { legacy } from "../test/fixtures.ts";
import { renderCharacterSheet } from "@ren-ai/personas";
import { withPublicProfile } from "@ren-ai/personas/profile";
import { inspectPersona, parseCharacterDescription, versionedPersona } from "@ren-ai/personas";
import { birthDateOf } from "@ren-ai/personas/birth-date";

const description = renderCharacterSheet(sheet);
test("human-edited spacing and blank lines do not change the character or its language background", () => {
  const value = { ...sheet, languageBackground: { primary: "en", native: ["en", "ko"] } };
  const source = renderCharacterSheet(value)
    .replaceAll("\n\n", "\n")
    .replaceAll("\n", "\n\n\n")
    .split("\n")
    .map((line) => `  ${line}  `)
    .join("\r\n")
    .replaceAll(": ", ":   ");
  expect(parseCharacterDescription(source)).toEqual(value);
  expect(birthDateOf(source)).toBe(sheet.birthDate);
});
test("the current description format round-trips all fixed fields, multiline reasons, traits and both genders", () => {
  expect(parseCharacterDescription(description)).toEqual(sheet);
  const male = {
    ...sheet,
    gender: "male" as const,
    hidden: [],
    samples: ["안녕하세요.", "네, 그래요."],
  };
  expect(parseCharacterDescription(renderCharacterSheet(male).replaceAll("\n", "\r\n"))).toEqual(
    male,
  );
  const multiline = {
    ...sheet,
    base: {
      ...sheet.base,
      autonomy: { value: 85, reason: "자기 시간을 소중히 여겨요.\n\n함께 정할 수도 있어요." },
    },
    hidden: [
      ...sheet.hidden,
      {
        name: "조심스러운 부탁",
        strength: 20,
        context: "낯선 모임\n친구들 사이",
        reason: "천천히 마음을 열어요.",
      },
    ],
  };
  expect(parseCharacterDescription(renderCharacterSheet(multiline))).toEqual(multiline);
});
test.each([
  "plain old description",
  `prefix\n${description}`,
  description.replace("## 성장 배경", "## 말투"),
  description.replace("## 생활·목표", "## 다른 섹션"),
  description.replace(sheet.background, ""),
  description.replace("성별: 여성", "성별: 다른 값"),
  description.replace("자율성: 85", "자율성: -1"),
  description.replace("자율성: 85", "없는 축: 85"),
  description.replace("자율성: 85", "자율성: 101"),
  description.replace("연락 주도성: 25", "자율성: 25"),
  description.replace("## 처음부터", "- 자율성: 35 — 근거\n\n## 처음부터"),
  description.replace("강도: 80", "강도: invalid"),
  description.replace("- 안녕하세요.", "안녕하세요."),
  description.replace("강도: 80", "강도: 101"),
  renderCharacterSheet({ ...sheet, samples: ["한 개뿐"] }),
  renderCharacterSheet({ ...sheet, background: "x".repeat(2001) }),
  description.replace(`이름: ${sheet.name}`, "이름:  "),
  renderCharacterSheet({ ...sheet, hidden: [...sheet.hidden, ...sheet.hidden] }),
])("invalid persisted descriptions produce a payload-free format error", (source) => {
  expect(() => parseCharacterDescription(source)).toThrow(
    "현재 Persona 시트의 섹션·이름·성별·Stat·특성 형식을 확인해 주세요.",
  );
});
test("version markers are earned by validation while inspection judges content independently of metadata", () => {
  const original = {
    ...legacy,
    name: sheet.name,
    description: withPublicProfile(description, "안녕하세요."),
  };
  expect(versionedPersona(original).descriptionVersion).toBe(2);
  expect(
    versionedPersona({ ...original, gender: "male", descriptionVersion: 1 }),
  ).not.toHaveProperty("descriptionVersion");
  expect(versionedPersona({ ...original, name: "다른 이름" })).not.toHaveProperty(
    "descriptionVersion",
  );
  expect(versionedPersona({ ...legacy, descriptionVersion: 1 })).not.toHaveProperty(
    "descriptionVersion",
  );
  expect(inspectPersona(versionedPersona(original))).toMatchObject({
    status: "current",
    profileNeeded: false,
  });
  expect(inspectPersona({ ...original, publicProfile: "" })).toMatchObject({
    status: "current",
    profileNeeded: false,
  });
  expect(inspectPersona({ ...original, descriptionVersion: 1 }).status).toBe("current");
  expect(inspectPersona({ ...original, name: "다른 이름", descriptionVersion: 1 }).status).toBe(
    "repair",
  );
  expect(inspectPersona({ ...original, gender: "male", descriptionVersion: 1 }).status).toBe(
    "repair",
  );
  expect(inspectPersona(legacy).status).toBe("convert");
});
