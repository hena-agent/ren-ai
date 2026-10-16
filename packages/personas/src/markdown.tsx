import ReactMarkdown from "react-markdown";
import { cacheMarkdown } from "./markdown-cache.ts";
import { readProfileSections, profileSectionKind } from "./profile-sections.ts";
import { markdownDefinitions } from "./profile.ts";
const renderMarkdown = cacheMarkdown((markdown: string) =>
  ReactMarkdown({ children: markdown, skipHtml: true }),
);

export function MarkdownProfile({ markdown }: { markdown: string }) {
  const { introduction, sections } = readProfileSections(markdown);
  const definitions = markdownDefinitions(markdown);
  return (
    <div className="public-profile-sections">
      {renderMarkdown(`${introduction}\n\n${definitions}`)}
      {sections
        .filter(({ body }) => body.trim())
        .map(({ title, body }, index) => {
          const kind = profileSectionKind(title);
          return (
            <section className={`public-profile-section profile-${kind}`} key={index}>
              <h3>{kind === "answer" ? title.slice(4) : title}</h3>
              {renderMarkdown(`${body}\n\n${definitions}`)}
            </section>
          );
        })}
    </div>
  );
}
