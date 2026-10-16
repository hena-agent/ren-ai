import { markdownHeadings } from "./profile.ts";

export const profileSectionTitles = [
  "기본 정보",
  "관심사",
  "라이프스타일",
  "관계 스타일",
  "문답",
  "자유 항목",
] as const;
export type ProfileSection = { title: string; body: string };

export function readProfileSections(markdown: string) {
  const headings = markdownHeadings(markdown).filter((heading) => heading.depth === 3);
  return {
    introduction: markdown.slice(0, headings[0]?.start).trim(),
    sections: headings.map((heading, index) => ({
      title: heading.title,
      body: markdown.slice(heading.end, headings[index + 1]?.start).trim(),
    })),
  };
}

export function writeProfileSections(profile: ReturnType<typeof readProfileSections>) {
  return [
    profile.introduction,
    ...profile.sections.map(({ title, body }) => `### ${title}\n\n${body}`),
  ]
    .join("\n\n")
    .trim();
}

export function profileSectionKind(title: string) {
  if (title.startsWith("문답: ")) return "answer";
  if (title === "관심사") return "interests";
  if (["기본 정보", "라이프스타일", "관계 스타일"].includes(title)) return "facts";
  return "text";
}
