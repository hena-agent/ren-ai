import { stateStatus } from "@ren-ai/personas";
import type { InitialDocuments, PersonaRecord } from "@ren-ai/personas";
import type { Draft } from "./draft.ts";
import { documentStatus } from "./document-diagnostics.ts";
import { ImprovementControls } from "./improvement-controls.tsx";

export function DocumentEditor({
  persona,
  locked,
  editing,
  action,
  conversion,
  improvementInput,
  documents = { state: "", memory: "" },
  tab = "persona",
}: {
  persona: PersonaRecord;
  locked: boolean;
  editing: boolean;
  action: string;
  conversion?: Draft["conversion"];
  improvementInput?: Draft["improvementInput"];
  documents?: InitialDocuments;
  tab?: Draft["tab"];
}) {
  const source = (persona.description ?? persona.prompt).replace(/\r\n?/g, "\n");
  const result = documentStatus(
    source,
    persona.name,
    persona.gender,
    persona.descriptionVersion === undefined,
  );
  const stateResult = stateStatus(documents.state, source);
  return (
    <section
      className="persona-document-editor"
      data-document-editor
      data-format={result.state}
      data-previous-format={String(persona.descriptionVersion === undefined)}
      data-gender={persona.gender}
    >
      <input type="hidden" name="tab" value={tab} />
      <div className="document-tabs" role="tablist" aria-label="페르소나 문서">
        {(["persona", "state", "memory"] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`tab-${key}`}
            data-editor-tab={key}
            aria-selected={tab === key}
            aria-controls={`pane-${key}`}
            tabIndex={tab === key ? 0 : -1}
          >
            {key === "persona" ? "Persona" : key === "state" ? "State" : "Memory"}
          </button>
        ))}
      </div>
      <section
        role="tabpanel"
        id="pane-persona"
        aria-labelledby="tab-persona"
        hidden={tab !== "persona"}
      >
        <div className="document-tools">
          <label htmlFor="name">
            이름
            <input id="name" name="name" defaultValue={persona.name} required readOnly={locked} />
          </label>
          <span className="document-status" data-document-status>
            {result.label}
          </span>
          <div className="document-actions">
            {editing && <a href={`${action}/persona.md`}>내려받기</a>}
          </div>
        </div>
        <ImprovementControls locked={locked} input={improvementInput} result={conversion} />
        <div data-public-profile-editor />
        <div className="document-source">
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
            aria-label="Persona 원문"
          />
        </div>
        <ul
          className="document-issues"
          id="document-issues"
          data-document-issues
          aria-live="polite"
        >
          {result.issues.map((entry, index) => (
            <li key={index}>
              <button
                type="button"
                data-document-start={entry.start}
                data-document-end={entry.end}
                data-document-line={entry.line}
              >
                {entry.section}: {entry.message}
              </button>
            </li>
          ))}
        </ul>
      </section>
      {(["state", "memory"] as const).map((key) => (
        <section
          key={key}
          role="tabpanel"
          id={`pane-${key}`}
          aria-labelledby={`tab-${key}`}
          hidden={tab !== key}
          data-state-format={key === "state" ? stateResult.state : undefined}
        >
          <div className="document-tools">
            <span className="document-file">{key === "state" ? "STATE.md" : "MEMORY.md"}</span>
            {key === "state" && (
              <span className="document-status" data-state-status>
                {stateResult.label}
              </span>
            )}
            <div className="document-actions">
              {editing && <a href={`${action}/${key}.md`}>내려받기</a>}
              <button
                className="secondary"
                type="submit"
                name="intent"
                value={key}
                disabled={locked || result.state !== "valid"}
              >
                Persona로 {key === "state" ? "State" : "Memory"} 다시 생성
              </button>
            </div>
          </div>
          <div className="document-source" data-initial-document={key}>
            <div data-initial-markdown-editor />
            <textarea
              id={`${key}-source`}
              name={`${key}Source`}
              defaultValue={documents[key]}
              readOnly={locked}
              rows={16}
              maxLength={16000}
              spellCheck={false}
              aria-label={`${key === "state" ? "State" : "Memory"} 원문`}
              aria-invalid={key === "state" && stateResult.state === "invalid"}
              aria-describedby={key === "state" ? "state-issues" : undefined}
            />
          </div>
          {key === "state" && (
            <ul className="document-issues" id="state-issues" data-state-issues aria-live="polite">
              {stateResult.issues.map((issue, index) => (
                <li key={index}>
                  <button type="button">
                    {issue.line}행 · {issue.message}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="document-hint">
            {key === "state"
              ? "상태값은 정수 0–100 · affection은 처음 만난 상대에 대한 출발 호감도로 직접 수정할 수 있습니다. 친숙함·신뢰·행동 확률이 아니며, 기존 대화에는 다시 적용하지 않습니다. 숨겨진 특성은 Persona와 일치해야 합니다."
              : "현재 생활과 진행 중인 일 · 상대와의 경험이나 약속은 넣지 않습니다."}
          </p>
        </section>
      ))}
    </section>
  );
}
