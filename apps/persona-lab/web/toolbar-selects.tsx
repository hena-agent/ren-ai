import type { SessionInfo } from "../src/store.ts";

export const ToolbarSelects = ({
  persona,
  sessions,
  sessionId,
  busy,
  selectPersona,
  selectSession,
}: {
  persona: string;
  sessions: SessionInfo[];
  sessionId: string;
  busy: boolean;
  selectPersona: (value: string) => void;
  selectSession: (value: string) => void;
}) => {
  const selected = sessions.find((info) => info.id === sessionId);
  return (
    <div className="toolbar-selects">
      <label className="picker">
        <span className="picker-label">관찰할 인물</span>
        <span className="picker-control">
          <span className="picker-value" aria-hidden="true">
            <strong>{persona === "harin" ? "하린" : "지우"}</strong>
            <span className="picker-secondary">{persona === "harin" ? "사진가" : "새 직장"}</span>
          </span>
          <span className="picker-chevron" aria-hidden="true" />
          <select
            value={persona}
            disabled={busy}
            onChange={(event) => selectPersona(event.target.value)}
          >
            <option value="harin">하린 · 사진가</option>
            <option value="jiwoo">지우 · 새 직장</option>
          </select>
        </span>
      </label>
      <label className="picker picker-session">
        <span className="picker-label">세션</span>
        <span className="picker-control">
          <span className="picker-value" aria-hidden="true">
            <strong className="session-id">
              {selected ? selected.id.slice(0, 8) : "세션 선택"}
            </strong>
            {selected && <span className="session-count">{selected.events}건</span>}
          </span>
          <span className="picker-chevron" aria-hidden="true" />
          <select
            value={sessionId}
            disabled={!sessionId || busy}
            onChange={(event) => selectSession(event.target.value)}
          >
            {sessions.map((info) => (
              <option value={info.id} key={info.id}>
                {info.id.slice(0, 8)} · {info.events}건
              </option>
            ))}
          </select>
        </span>
      </label>
    </div>
  );
};
