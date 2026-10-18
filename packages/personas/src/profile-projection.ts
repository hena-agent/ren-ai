import { fromMarkdown } from "mdast-util-from-markdown";
import { toString } from "mdast-util-to-string";
import { readProfileSections } from "./profile-sections.ts";
import { basicProfileFields, isIdentityFact } from "./public-profile.ts";
import type { PublicProfile } from "./public-profile.ts";

const plain = (source: string) =>
  fromMarkdown(source)
    .children.filter((node) => node.type !== "html" && node.type !== "definition")
    .map((node) =>
      node.type === "list"
        ? node.children.map((item) => `• ${toString(item, { includeHtml: false })}`).join("\n")
        : toString(node, { includeHtml: false }),
    )
    .join("\n\n")
    .split("\n")
    .filter((line) => !isIdentityFact(line.replace(/^• /, "")))
    .join("\n")
    .trim();

function listItems(body: string) {
  const nodes = fromMarkdown(body).children.filter((node) => node.type !== "definition");
  const list = nodes[0]!;
  if (nodes.length !== 1 || list.type !== "list") return undefined;
  const items = list.children.map((item) =>
    item.children.length === 1 && item.children[0]!.type === "paragraph"
      ? toString(item, { includeHtml: false }).trim()
      : "",
  );
  return items.every(Boolean) ? items : undefined;
}

function facts(items: readonly string[], basic: boolean) {
  const seen = new Set<string>();
  const rows = [];
  for (const item of items) {
    const colon = item.indexOf(":");
    const label = item.slice(0, colon).trim();
    const value = item.slice(colon + 1).trim();
    if (colon === -1 || !label || !value || seen.has(label)) return undefined;
    seen.add(label);
    if (isIdentityFact(`${label}:`)) continue;
    const key = basic ? basicProfileFields.find((field) => field.label === label)?.key : undefined;
    rows.push({ label, value, ...(key && { key }) });
  }
  return rows;
}

function sectionOf(title: string, body: string): PublicProfile["sections"][number] {
  const items = listItems(body);
  if (title === "관심사" && items) return { type: "interests", title, items };
  const factTypes = {
    "기본 정보": "basics",
    라이프스타일: "lifestyle",
    "관계 스타일": "relationship",
  } as const;
  const type = Object.entries(factTypes).find(([label]) => label === title)?.[1];
  const rows = type && items && facts(items, type === "basics");
  if (rows) return { type, title, items: rows };
  if (title.startsWith("문답:")) {
    const question = title.slice(3).trim();
    if (question) return { type: "prompt", question, answer: plain(body) };
  }
  return { type: "text", title, body: plain(body) };
}

/** Takes only the explicitly public Markdown, never the private Persona document. */
export function projectPublicProfile(markdown: string): PublicProfile {
  const { introduction, sections } = readProfileSections(markdown);
  const definitions = fromMarkdown(markdown)
    .children.filter((node) => node.type === "definition")
    .map((node) => markdown.slice(node.position!.start.offset, node.position!.end.offset))
    .join("\n");
  return {
    introduction: plain(`${introduction}\n\n${definitions}`),
    sections: sections
      .map(({ title, body }) => ({ title, body: `${body}\n\n${definitions}` }))
      .filter(({ title, body }) => !isIdentityFact(title) && plain(body))
      .map(({ title, body }) => sectionOf(title, body))
      .filter((section) => section.type !== "basics" || section.items.length > 0),
  };
}
