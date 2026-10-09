import ReactMarkdown from "react-markdown";
import { cacheMarkdown } from "./markdown-cache.ts";
const renderMarkdown = cacheMarkdown((markdown: string) =>
  ReactMarkdown({ children: markdown, skipHtml: true }),
);

export function MarkdownProfile({ markdown }: { markdown: string }) {
  return renderMarkdown(markdown);
}
