import { stateStatus } from "@ren-ai/personas";
import type { InitialDocuments, PersonaRecord } from "@ren-ai/personas";
import type { Draft } from "./draft.ts";
import { documentStatus } from "./document-diagnostics.ts";
import { LanguagePanel } from "./language-panel.tsx";
import { ImprovementControls } from "./improvement-controls.tsx";
import { ProfileHelp } from "./profile-help.tsx";

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
            <button
              id="open-improvement"
              type="button"
              className="secondary"
              data-document-dialog="improvement-dialog"
              disabled={locked}
            >
              페르소나 개선
            </button>
            {editing && <a href={`${action}/persona.md`}>내려받기</a>}
          </div>
        </div>
        <ImprovementControls locked={locked} input={improvementInput} />
        <ProfileHelp />
        <div className="document-source-heading">
          <span>Persona 초안</span>
          <div className="document-actions">
            <button type="button" className="secondary" data-jump-public-profile>
              공개 프로필로 이동
            </button>
            <button
              id="open-profile-help"
              type="button"
              className="secondary profile-help-button"
              data-document-dialog="profile-help-dialog"
              aria-label="공개 프로필 작성 도움말"
            >
              ?
            </button>
          </div>
        </div>
        {conversion && (
          <section className="improvement-diff" aria-label="개선 변경 내용">
            <div className="improvement-diff-heading">
              <output>개선 내용을 초안에 반영했습니다 · 저장 전</output>
              <label className="toggle">
                <input type="checkbox" data-improvement-diff defaultChecked />
                변경 표시
              </label>
            </div>
            <p className="diff-legend">
              <span>+ 추가</span>
              <span>− 삭제</span>
            </p>
            {conversion.additions.length > 0 && (
              <details>
                <summary>개선 요약</summary>
                <ul>
                  {conversion.additions.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              </details>
            )}
            <textarea hidden readOnly data-improvement-source value={conversion.source} />
          </section>
        )}
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
          {key === "state" && (
            <div data-language-panel>
              <LanguagePanel source={source} documents={documents} locked={locked} />
            </div>
          )}
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
