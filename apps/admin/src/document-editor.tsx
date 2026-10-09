import type { PersonaRecord } from "@ren-ai/personas";
import type { Draft } from "./draft.ts";
import { documentStatus } from "./document-diagnostics.ts";
import { DocumentPreview } from "./document-preview.tsx";

export function DocumentEditor({
  persona,
  locked,
  editing,
  action,
  conversion,
}: {
  persona: PersonaRecord;
  locked: boolean;
  editing: boolean;
  action: string;
  conversion?: Draft["conversion"];
}) {
  const source = (persona.description ?? persona.prompt).replace(/\r\n?/g, "\n");
  const result = documentStatus(
    source,
    persona.name,
    persona.gender,
    persona.descriptionVersion === undefined,
  );
  return (
    <section
      className="persona-document-editor"
      data-document-editor
      data-format={result.state}
      data-previous-format={String(persona.descriptionVersion === undefined)}
      data-gender={persona.gender}
      aria-labelledby="document-title"
    >
      <div className="document-header">
        <h2 className="document-file" id="document-title">
          persona.md 원본
        </h2>
        <span className="document-status" data-document-status>
          {result.label}
        </span>
      </div>
      <div className="document-tools">
        <label htmlFor="name">
          이름
          <input id="name" name="name" defaultValue={persona.name} required readOnly={locked} />
        </label>
        <div className="document-actions">
          {editing && (
            <>
              <button
                type="submit"
                name="intent"
                value="convert"
                data-document-convert
                hidden={result.state === "valid" || result.state === "empty"}
                disabled={locked}
              >
                현재 형식으로 정리
              </button>
              <a href={`${action}/persona.md`}>Markdown 내려받기</a>
            </>
          )}
        </div>
      </div>
      <div className="document-view-controls">
        <button
          type="button"
          data-document-mode="edit"
          aria-pressed="true"
          aria-controls="document-edit-pane"
        >
          편집
        </button>
        <button
          type="button"
          data-document-mode="preview"
          aria-pressed="false"
          aria-controls="document-preview-pane"
          className="secondary"
        >
          미리보기
        </button>
      </div>
      <div className="document-workspace">
        <div className="document-source" id="document-edit-pane">
          <h2 className="document-source-label">Markdown 원문</h2>
          <div data-markdown-editor />
          <textarea
            id="description"
            name="description"
            defaultValue={source}
            required
            readOnly={locked}
            rows={20}
            spellCheck={false}
            aria-invalid={result.state === "invalid"}
            aria-describedby="document-issues"
            aria-label="persona.md Markdown 원문"
          />
        </div>
        <section
          className="document-preview"
          id="document-preview-pane"
          hidden
          aria-label="문서 미리보기"
        >
          <div data-document-preview>
            <DocumentPreview source={source} />
          </div>
        </section>
      </div>
      <ul className="document-issues" id="document-issues" data-document-issues aria-live="polite">
        {result.issues.map((entry, index) => (
          <li key={index}>
            <button
              type="button"
              data-document-start={entry.start}
              data-document-end={entry.end}
              data-document-line={entry.line}
            >
              <strong>{entry.section}</strong>
              <span>{entry.message}</span>
              <small>{entry.line}행</small>
            </button>
          </li>
        ))}
      </ul>
      {conversion && conversion.additions.length > 0 && (
        <section className="conversion-report" aria-label="정리 결과">
          <h3>정리 결과 · 보강 {conversion.additions.length}개</h3>
          <ul>
            {conversion.additions.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
