import { MarkdownProfile } from "@ren-ai/personas/markdown";
import { markdownHeadings } from "@ren-ai/personas/profile";

export function DocumentPreview({ source }: { source: string }) {
  const boundary = markdownHeadings(source).find(
    (heading) => heading.depth === 2 && heading.title === "공개 프로필",
  );
  return (
    <div className="document-preview-content">
      <section className="private-document-preview" aria-label="내부 설정 미리보기">
        <h3 className="preview-boundary">내부 설정 · 비공개</h3>
        <MarkdownProfile markdown={source.slice(0, boundary?.start)} />
      </section>
      {boundary && (
        <section className="public-document-preview" aria-label="공개 프로필 미리보기">
          <h3 className="preview-boundary">공개 프로필 · 사용자에게 표시</h3>
          <MarkdownProfile markdown={source.slice(boundary.end)} />
        </section>
      )}
    </div>
  );
}
