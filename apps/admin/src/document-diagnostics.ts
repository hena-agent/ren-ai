import { markdownHeadings, splitPersonaMarkdown } from "@ren-ai/personas/profile";
import {
  CharacterFormatError,
  parseCharacterDescription,
  privateSectionTitles,
} from "@ren-ai/personas";

type Heading = ReturnType<typeof markdownHeadings>[number];
const issueAt = (source: string, section: string, message: string, start: number, end: number) => ({
  section,
  message,
  start,
  end,
  line: source.slice(0, start).split("\n").length,
});

function locate(
  source: string,
  headings: Heading[],
  section: string,
  message: string,
  excerpt = "",
) {
  const heading = headings.find((entry) => entry.title === section);
  const found = excerpt ? source.indexOf(excerpt, heading?.end) : -1;
  return issueAt(
    source,
    section || "문서 구조",
    message,
    found < 0 ? (heading?.start ?? 0) : found,
    found < 0 ? (heading?.end ?? source.indexOf("\n") + 1) : found + excerpt.length,
  );
}

function privateStructure(
  source: string,
  headings: Heading[],
  boundary: Heading | undefined,
  previousFormat: boolean,
) {
  const privateHeadings = headings.filter(
    (entry) => entry.depth === 2 && entry.start < (boundary?.start ?? source.length),
  );
  const missing = privateSectionTitles.filter(
    (title) => !privateHeadings.some((entry) => entry.title === title),
  );
  const legacy = previousFormat && missing.length > 0;
  const issues: ReturnType<typeof issueAt>[] = [];
  if (!legacy && missing.length)
    issues.push(
      issueAt(
        source,
        "문서 구조",
        `필수 섹션을 추가해 주세요: ${missing.join(", ")}`,
        boundary?.start ?? source.length,
        boundary?.end ?? source.length,
      ),
    );
  for (const title of privateSectionTitles) {
    const duplicate = privateHeadings.filter((entry) => entry.title === title)[1];
    if (duplicate)
      issues.push(
        issueAt(
          source,
          title,
          "중복 섹션입니다. 하나로 합쳐 주세요.",
          duplicate.start,
          duplicate.end,
        ),
      );
  }
  return { issues, legacy };
}

function identityIssues(
  source: string,
  headings: Heading[],
  name: string,
  gender: "female" | "male" | undefined,
) {
  const sheet = parseCharacterDescription(source);
  const issues: ReturnType<typeof issueAt>[] = [];
  if (sheet.name !== name)
    issues.push(
      locate(
        source,
        headings,
        "정체성·외형",
        "문서의 이름과 관리 이름이 일치하지 않습니다.",
        `이름: ${sheet.name}`,
      ),
    );
  if (gender && sheet.gender !== gender)
    issues.push(
      locate(
        source,
        headings,
        "정체성·외형",
        "문서의 성별과 관리 정보가 일치하지 않습니다.",
        `성별: ${sheet.gender === "female" ? "여성" : "남성"}`,
      ),
    );
  return issues;
}

export function documentStatus(
  source: string,
  name: string,
  gender?: "female" | "male",
  previousFormat = false,
) {
  source = source.replace(/\r\n?/g, "\n");
  const headings = markdownHeadings(source);
  const issues: ReturnType<typeof issueAt>[] = [];
  let legacy = false;
  if (!source.trim()) return { state: "empty" as const, label: "생성 전", issues };
  try {
    const parts = splitPersonaMarkdown(source);
    const boundary = headings.find((entry) => entry.depth === 2 && entry.title === "공개 프로필");
    if (!parts.bio)
      issues.push(
        issueAt(
          source,
          "공개 프로필",
          "공개 영역은 짧은 자기소개 문단으로 시작해야 합니다.",
          boundary?.start ?? source.length,
          boundary?.end ?? source.length,
        ),
      );
    const structure = privateStructure(source, headings, boundary, previousFormat);
    legacy = structure.legacy;
    issues.push(...structure.issues);
    if (!legacy && !issues.length) issues.push(...identityIssues(source, headings, name, gender));
  } catch (cause) {
    if (cause instanceof CharacterFormatError)
      issues.push(locate(source, headings, cause.section, cause.detail, cause.excerpt));
    else {
      const publicHeadings = headings.filter(
        (entry) => entry.depth === 2 && entry.title === "공개 프로필",
      );
      const invalid =
        publicHeadings[1] ??
        headings.find((entry) => entry.depth <= 2 && entry.start > publicHeadings[0]!.start)!;
      issues.push(
        issueAt(
          source,
          "공개 프로필",
          "공개 경계는 한 번만, 마지막 영역에 작성해 주세요. 공개 제목은 ###부터 사용합니다.",
          invalid.start,
          invalid.end,
        ),
      );
    }
  }
  const state = issues.length
    ? ("invalid" as const)
    : legacy
      ? ("legacy" as const)
      : ("valid" as const);
  return {
    state,
    issues,
    label:
      state === "invalid"
        ? `오류 ${issues.length}개`
        : state === "legacy"
          ? "이전 형식 · 정리 가능"
          : "형식 정상",
  };
}
