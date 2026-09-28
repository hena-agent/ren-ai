import type { SessionInfo } from "../src/store.ts";
import {
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
} from "./components/ai-elements/prompt-input.tsx";

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
      <div className="picker">
        <label className="picker-label" htmlFor="persona-select">
          관찰할 인물
        </label>
        <PromptInputSelect value={persona} onValueChange={selectPersona} disabled={busy}>
          <PromptInputSelectTrigger id="persona-select" className="picker-control">
            <span className="picker-value" aria-hidden="true">
              <strong>{persona === "harin" ? "하린" : "지우"}</strong>
              <span className="picker-secondary">{persona === "harin" ? "사진가" : "새 직장"}</span>
            </span>
            <span className="sr-only">
              <PromptInputSelectValue>
                {persona === "harin" ? "하린 · 사진가" : "지우 · 새 직장"}
              </PromptInputSelectValue>
            </span>
          </PromptInputSelectTrigger>
          <PromptInputSelectContent>
            <PromptInputSelectItem value="harin">하린 · 사진가</PromptInputSelectItem>
            <PromptInputSelectItem value="jiwoo">지우 · 새 직장</PromptInputSelectItem>
          </PromptInputSelectContent>
        </PromptInputSelect>
      </div>
      <div className="picker picker-session">
        <label className="picker-label" htmlFor="session-select">
          세션
        </label>
        <PromptInputSelect
          value={sessionId}
          onValueChange={selectSession}
          disabled={!sessionId || busy}
        >
          <PromptInputSelectTrigger id="session-select" className="picker-control">
            <span className="picker-value" aria-hidden="true">
              <strong className="session-id">
                {selected ? selected.id.slice(0, 8) : "세션 선택"}
              </strong>
              {selected && <span className="session-count">{selected.events}건</span>}
              {selected?.paused && <span className="session-count">일시정지</span>}
            </span>
            <span className="sr-only">
              <PromptInputSelectValue placeholder="세션 선택">
                {selected
                  ? `${selected.id.slice(0, 8)} · ${selected.events}건${selected.paused ? " · 일시정지" : ""}`
                  : "세션 선택"}
              </PromptInputSelectValue>
            </span>
          </PromptInputSelectTrigger>
          <PromptInputSelectContent>
            {sessions.map((info) => (
              <PromptInputSelectItem value={info.id} key={info.id}>
                {info.id.slice(0, 8)} · {info.events}건{info.paused ? " · 일시정지" : ""}
              </PromptInputSelectItem>
            ))}
          </PromptInputSelectContent>
        </PromptInputSelect>
      </div>
    </div>
  );
};
