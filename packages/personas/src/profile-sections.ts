import { markdownHeadings } from "./profile.ts";

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

export function profileSectionKind(title: string) {
  if (title.startsWith("문답:")) return "answer";
  if (title === "관심사") return "interests";
  if (["기본 정보", "라이프스타일", "관계 스타일"].includes(title)) return "facts";
  return "text";
}
