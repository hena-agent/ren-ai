import { expect, test } from "vitest";
import { splitPersonaMarkdown, requirePublicProfile, withPublicProfile } from "./profile.ts";
import { cacheMarkdown } from "./markdown-cache.ts";

test("AST extraction recognizes only the explicit public boundary and derives the mandatory plain-text introduction", () => {
  const source =
    "Private interests never disclosed.\n\n```md\n## 공개 프로필\nnot public\n```\n\n## 공개 프로필\n\n안녕하세요. **천천히** 알아가요.\n\n### 내가 편해지는 순간\n조용히 같이 있을 때.";
  const parts = requirePublicProfile(source);
  expect(parts.bio).toBe("안녕하세요. 천천히 알아가요.");
  expect(parts.publicMarkdown).not.toContain("Private interests");
  expect(parts.publicMarkdown).not.toContain("not public");
  expect(parts.publicMarkdown).toContain("### 내가 편해지는 순간");
  expect(requirePublicProfile(source.replaceAll("\n", "\r\n"))).toEqual(parts);
  expect(splitPersonaMarkdown("private draft")).toEqual({
    privateMarkdown: "private draft",
    publicMarkdown: "",
    bio: "",
  });
});
test.each([
  "## 공개 프로필\n\n자기소개.",
  "Private\n\n## 공개 프로필\n\n### 소개 없이 시작",
  "Private\n\n## 공개 프로필\n\n소개.\n\n## 비공개 설정\n다른 영역",
  "Private\n\n## 공개 프로필\n\n소개.\n\n## 공개 프로필\n중복",
  "Private\n\n## 공개 프로필",
])("invalid or ambiguous publication boundaries are rejected", (source) => {
  expect(() => requirePublicProfile(source)).toThrow(/공개 프로필|자기소개/);
});
test("public Markdown replacements preserve private source without creating missing-interest placeholders", () => {
  const source = withPublicProfile(
    "Private",
    "안녕하세요.\n\n### 하고 싶은 일\n- 걷기\n\n### 대화 스타일\n천천히.",
  );
  const edited = withPublicProfile(
    source,
    "안녕하세요.\n\n### 좋아하는 시간\n조용한 저녁.\n\n### 대화 스타일\n천천히.",
  );
  expect(edited).toContain("좋아하는 시간");
  expect(edited).toContain("### 대화 스타일");
  const removed = withPublicProfile(edited, "안녕하세요.\n\n### 대화 스타일\n천천히.");
  expect(removed).not.toContain("좋아하는 시간");
  expect(removed).not.toContain("관심사");
  expect(splitPersonaMarkdown(removed).privateMarkdown).toBe("Private");
  expect(() => requirePublicProfile(withPublicProfile(source, "### intro removed"))).toThrow(
    "자기소개 문단",
  );
});

test("repeated inspection and previews reuse parsing with a bounded process-local cache", () => {
  let parsed = 0;
  const parse = cacheMarkdown((text: string) => {
    parsed++;
    return { text };
  });
  const original = parse("original");
  expect(parse("original")).toBe(original);
  for (let index = 0; index < 65; index++) parse(`different-${index}`);
  expect(parse("original")).not.toBe(original);
  expect(parsed).toBe(67);
});

test("public fact rows cannot duplicate identity age or expose a birthday", () => {
  for (const label of ["나이", "생년월일", "Age", "birthDate", "date of birth"]) {
    expect(() =>
      requirePublicProfile(
        withPublicProfile("Private", `소개.\n\n### 기본 정보\n- ${label}: 1998-04-12`),
      ),
    ).toThrow("정체성의 생년월일");
  }
  for (const content of [
    "나이: 28",
    "나이 28세",
    "생년월일: 1998-04-12",
    "### 생년월일\n1998-04-12",
    "- 직업: 도예가\n\n나이: 28",
    "```text\n나이: 28\n```\n\n나이: 28",
  ]) {
    expect(() =>
      requirePublicProfile(withPublicProfile("Private", `소개.\n\n### 기본 정보\n${content}`)),
    ).toThrow("정체성의 생년월일");
  }
  expect(
    requirePublicProfile(
      withPublicProfile("Private\n- 나이: 27", "소개.\n\n### 기억\n27살에 도예를 시작했어요."),
    ),
  ).toHaveProperty("bio", "소개.");
});
