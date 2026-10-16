import { expect, test } from "vitest";
import { readProfileSections } from "./profile-sections.ts";

test("section parsing preserves free Markdown and ignores headings inside code blocks", () => {
  const source =
    "소개 **문장**.\n\n```md\n### 가짜\n```\n\n### 관심사\n\n- 재즈\n- 산책\n\n### 나만의 제목\n\n문단\n\n#### 작은 제목\n\n내용";
  const profile = readProfileSections(source);
  expect(profile.sections).toEqual([
    { title: "관심사", body: "- 재즈\n- 산책" },
    { title: "나만의 제목", body: "문단\n\n#### 작은 제목\n\n내용" },
  ]);
  expect(profile.introduction).toBe("소개 **문장**.\n\n```md\n### 가짜\n```");
  expect(readProfileSections("소개만 있어요.")).toEqual({
    introduction: "소개만 있어요.",
    sections: [],
  });
  expect(readProfileSections("")).toEqual({ introduction: "", sections: [] });
});
