import type { PersonaRecord, PersonaVersion, VersionSummary } from "@ren-ai/personas";

export interface VersionView {
  current: PersonaRecord;
  currentVersion: number;
  versions: readonly VersionSummary[];
  selected: PersonaVersion;
  draft: string;
}

export function VersionPage({ current, currentVersion, versions, selected, draft }: VersionView) {
  const path = `/personas/${current.id}`;
  return (
    <section className="version-history" aria-labelledby="versions-title">
      <a className="editor-back" href={path}>
        ← 편집으로
      </a>
      <div className="version-heading">
        <h1 id="versions-title">{current.name} · 버전 기록</h1>
        <span>현재 v{currentVersion}</span>
      </div>
      <p className="hint">
        저장한 최신 Persona 문서가 에이전트에 자동 반영됩니다. 복원은 과거 내용을 담은 새 최신
        버전을 만듭니다.
      </p>
      <nav className="version-list" aria-label="Persona 버전">
        {versions.map((entry) => (
          <a
            key={entry.version}
            href={`${path}/versions?version=${entry.version}`}
            aria-current={selected.version === entry.version ? "page" : undefined}
          >
            <strong>
              v{entry.version}
              {entry.version === currentVersion ? " · 현재" : ""}
            </strong>
            <time dateTime={new Date(entry.createdAt).toISOString()}>
              {new Date(entry.createdAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}
            </time>
            <span>{entry.restoredFrom === null ? "저장" : `v${entry.restoredFrom}에서 복원`}</span>
          </a>
        ))}
      </nav>
      <div className="improvement-comparison">
        <label htmlFor="version-current">
          현재 v{currentVersion}
          <textarea id="version-current" readOnly rows={18} value={current.prompt} />
        </label>
        <label htmlFor="version-selected">
          선택한 v{selected.version}
          <textarea id="version-selected" readOnly rows={18} value={selected.markdown} />
        </label>
      </div>
      <p>
        Persona 문서만 복원합니다. 사진·초기 State/Memory·대화 중 쌓인 상태와 기억은 유지합니다.
      </p>
      <form
        action={`${path}/versions/${selected.version}/restore`}
        method="post"
        data-saving="Persona 버전을 복원하고 있습니다…"
      >
        <input type="hidden" name="draft" value={draft} />
        <button
          type="submit"
          value="save"
          disabled={selected.version === currentVersion}
          data-confirm-delete={`v${selected.version}의 Persona 문서를 새 최신 버전으로 복원할까요? 사진과 State/Memory는 유지됩니다.`}
        >
          v{selected.version} 내용으로 복원
        </button>
        <output data-pending aria-live="polite" />
      </form>
    </section>
  );
}
