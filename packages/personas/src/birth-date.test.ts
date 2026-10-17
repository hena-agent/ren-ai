import { Schema } from "effect";
import { afterEach, expect, test, vi } from "vitest";
import { BirthDate, birthDateOf, ageOn } from "./birth-date.ts";
import { renderCharacterSheet } from "./character-sheet.ts";
import { parseCharacterDescription } from "./character-format.ts";
import { documentStatus } from "./document-diagnostics.ts";
import { withPublicProfile } from "./profile.ts";
import { sheet } from "../../../apps/admin/test/sheet.ts";

afterEach(() => vi.useRealTimers());

test("identity requires a real nonfuture calendar birthday and diagnostics select the invalid row", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-17T00:00:00Z"));
  const decode = Schema.decodeUnknownSync(BirthDate);
  for (const value of ["2000-02-29", "1900-02-28", "2026-10-17"]) expect(decode(value)).toBe(value);
  for (const value of [
    "0000-01-01",
    "20대 중후반",
    "1998-4-12",
    "1900-02-29",
    "2001-02-29",
    "2000-13-01",
    "2026-10-18",
    "2000-04-31",
  ])
    expect(() => decode(value)).toThrow(/Expected/);
  const source = withPublicProfile(renderCharacterSheet(sheet), "안녕하세요.");
  expect(parseCharacterDescription(source).birthDate).toBe(sheet.birthDate);
  for (const value of ["20대 중후반", "2001-02-29", "2099-01-01"]) {
    const changed = source.replace(sheet.birthDate, value);
    const issue = documentStatus(changed, sheet.name).issues[0]!;
    expect(issue.section).toBe("정체성·외형");
    expect(changed.slice(issue.start, issue.end)).toBe(`생년월일: ${value}`);
  }
  for (const changed of [
    source.replace(`생년월일: ${sheet.birthDate}\n`, ""),
    source.replace(
      `생년월일: ${sheet.birthDate}`,
      `생년월일: ${sheet.birthDate}\n생년월일: ${sheet.birthDate}`,
    ),
  ])
    expect(() => parseCharacterDescription(changed)).toThrow(/Persona 시트/);
});

test("birthday lookup uses only the actual private identity header and never invents a missing date", () => {
  const source = renderCharacterSheet(sheet);
  expect(birthDateOf(source.replaceAll("\n", "\r\n"))).toBe(sheet.birthDate);
  expect(birthDateOf(source.replace(sheet.birthDate, "1998-02-30"))).toBeUndefined();
  expect(birthDateOf(`${source}\n\n## 다음 항목\n내용`)).toBe(sheet.birthDate);
  expect(birthDateOf("설정 작성 중")).toBeUndefined();
  expect(birthDateOf("## 정체성·외형\n\n이름: 인물\n성별: 여성\n\n20대 중후반")).toBeUndefined();
  expect(
    birthDateOf(withPublicProfile("비공개 설정", source.replaceAll("## ", "### "))),
  ).toBeUndefined();
  expect(birthDateOf(`\`\`\`markdown\n${source}\n\`\`\``)).toBeUndefined();
});

test("age advances on the UTC birthday without a persisted age or a viewer-local timezone", () => {
  expect(ageOn("1998-04-12", new Date("2026-04-11T23:59:59Z"))).toBe(27);
  expect(ageOn("1998-04-12", new Date("2026-04-12T00:00:00Z"))).toBe(28);
  expect(ageOn("2000-02-29", new Date("2025-02-28T23:59:59Z"))).toBe(24);
  expect(ageOn("2000-02-29", new Date("2025-03-01T00:00:00Z"))).toBe(25);
  expect(ageOn("2000-02-29", new Date("2024-02-29T00:00:00Z"))).toBe(24);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-04-12T00:00:00Z"));
  expect(ageOn("1998-04-12")).toBe(28);
});
