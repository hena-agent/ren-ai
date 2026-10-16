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
