import { fromMarkdown } from "mdast-util-from-markdown";
import { toString } from "mdast-util-to-string";
import { cacheMarkdown } from "./markdown-cache.ts";
const parseMarkdown = cacheMarkdown((source: string) => fromMarkdown(source));

export function markdownHeadings(markdown: string) {
  return parseMarkdown(markdown).children.flatMap((node) =>
    node.type === "heading"
      ? [
          {
            title: toString(node),
            depth: node.depth,
            line: node.position!.start.line,
            start: node.position!.start.offset!,
            end: node.position!.end.offset!,
          },
        ]
      : [],
  );
}

export const publicHeading = "공개 프로필";

export function markdownDefinitions(markdown: string) {
  return parseMarkdown(markdown)
    .children.filter((node) => node.type === "definition")
    .map((node) => markdown.slice(node.position!.start.offset, node.position!.end.offset))
    .join("\n");
}

export function splitPersonaMarkdown(markdown: string) {
  markdown = markdown.replace(/\r\n?/g, "\n");
  const document = parseMarkdown(markdown);
  const boundaries = document.children.filter(
    (node) => node.type === "heading" && node.depth === 2 && toString(node) === publicHeading,
  );
  if (boundaries.length > 1) throw new Error("공개 프로필 경계는 한 번만 작성해 주세요.");
  const boundary = boundaries[0];
  if (!boundary) return { privateMarkdown: markdown.trim(), publicMarkdown: "", bio: "" };
  const position = boundary.position!;
  const publicNodes = document.children.filter(
    (node) => node.position!.start.offset! >= position.end.offset!,
  );
  if (publicNodes.some((node) => node.type === "heading" && node.depth <= 2))
    throw new Error("공개 프로필은 마지막 영역이어야 하며 그 안의 제목은 ###부터 사용해 주세요.");
  const first = publicNodes[0];
  const bio = first?.type === "paragraph" ? toString(first, { includeHtml: false }).trim() : "";
  return {
    privateMarkdown: markdown.slice(0, position.start.offset).trim(),
    publicMarkdown: markdown.slice(position.end.offset).trim(),
    bio,
  };
}

export function requirePublicProfile(markdown: string) {
  const parts = splitPersonaMarkdown(markdown);
  if (!parts.privateMarkdown || !parts.bio)
    throw new Error("persona.md의 공개 프로필은 짧은 자기소개 문단으로 시작해야 합니다.");
  return parts;
}

export const withPublicProfile = (markdown: string, publicMarkdown: string) =>
  `${splitPersonaMarkdown(markdown).privateMarkdown}\n\n## ${publicHeading}\n\n${publicMarkdown.trim()}`;
