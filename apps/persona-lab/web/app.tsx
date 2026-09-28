import { useEffect, useRef } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  PromptInput,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
} from "./components/ai-elements/prompt-input.tsx";
import { Observations } from "./observations.tsx";
import { Timeline } from "./timeline.tsx";
import { ToolbarSelects } from "./toolbar-selects.tsx";
import { useLab } from "./use-lab.ts";

const EmptyTimeline = ({
  error,
  loading,
  retry,
}: {
  error: string;
  loading: boolean;
  retry: () => void;
}) => (
  <div className="timeline loading" role="status">
    {error ? (
      <button className="button button-outline" type="button" onClick={retry}>
        다시 시도
      </button>
    ) : loading ? (
      "세션을 불러오는 중입니다."
    ) : (
      "세션이 없습니다. 새 세션을 만들어 시작하세요."
    )}
  </div>
);

export const App = () => {
  const lab = useLab();
  const observationDialog = useRef<HTMLDialogElement>(null);
  const importInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1000px)");
    const closeOnDesktop = () => {
      if (desktop.matches) observationDialog.current?.close();
    };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Observation room / 001</p>
          <h1>Persona Lab</h1>
        </div>
        <span className="status">
          <span className="status-dot" /> LOCAL EXPERIMENT
        </span>
      </header>
      <main className="workspace">
        <section className="main-panel" aria-labelledby="conversation-title">
          <div className="toolbar">
            <ToolbarSelects
              persona={lab.persona}
              sessions={lab.sessions}
              sessionId={lab.current?.session.id ?? ""}
              busy={lab.busy}
              selectPersona={lab.selectPersona}
              selectSession={lab.selectSession}
            />
            <div className="toolbar-actions">
              <button
                className="button button-outline"
                type="button"
                disabled={lab.busy}
                onClick={lab.newSession}
              >
                새 세션
              </button>
              <DropdownMenu.Root modal={false}>
                <DropdownMenu.Trigger className="button button-outline">
                  기록 관리
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content className="action-menu" align="end" sideOffset={8}>
                    <DropdownMenu.Item
                      className="action-menu-item"
                      disabled={!lab.current || lab.busy}
                      onSelect={lab.reset}
                    >
                      인물 초기화
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      className="action-menu-item"
                      disabled={!lab.current || lab.busy}
                      onSelect={lab.togglePause}
                    >
                      {lab.current?.paused ? "자동 판단 재개" : "자동 판단 일시정지"}
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      className="action-menu-item"
                      disabled={!lab.current || lab.busy}
                      onSelect={lab.removeSession}
                    >
                      세션 삭제
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      className="action-menu-item"
                      disabled={!lab.current || lab.busy}
                      onSelect={() => void lab.download()}
                    >
                      기록 내려받기
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      className="action-menu-item"
                      disabled={lab.busy}
                      onSelect={() => importInput.current?.click()}
                    >
                      기록 불러오기
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
              <input
                ref={importInput}
                type="file"
                accept="application/json,.json"
                aria-label="기록 불러오기"
                hidden
                disabled={lab.busy}
                onChange={lab.importFile}
              />
            </div>
          </div>
          <div className="conversation-heading">
            <div>
              <p className="eyebrow">Conversation / 관찰 기록</p>
              <h2 id="conversation-title">대화와 사건</h2>
            </div>
            <div className="heading-actions">
              <span className="event-count">
                {lab.current?.session.events.length ?? 0}건의 기록
              </span>
              <button
                className="button button-outline mobile-observation-button"
                type="button"
                disabled={!lab.current}
                onClick={() => observationDialog.current?.showModal()}
              >
                인물의 현재
              </button>
            </div>
          </div>
          {lab.current ? (
            <Timeline current={lab.current} />
          ) : (
            <EmptyTimeline
              error={lab.error}
              loading={lab.loading}
              retry={() => lab.selectPersona(lab.persona)}
            />
          )}
          <div className="composer-area">
            <PromptInput id="composer" onSubmit={lab.send}>
              <label htmlFor="text">메시지 또는 실제 일어난 사건</label>
              <PromptInputTextarea
                id="text"
                value={lab.text}
                required
                disabled={!lab.current || lab.busy}
                placeholder="하린에게 말을 걸거나, 확정된 생활 사건을 기록하세요."
                onChange={(event) => lab.setText(event.target.value)}
              />
              <div className="form-actions">
                <div className="select-field">
                  <label htmlFor="input-kind-select">입력 종류</label>
                  <PromptInputSelect value={lab.kind} onValueChange={lab.setKind}>
                    <PromptInputSelectTrigger id="input-kind-select">
                      <PromptInputSelectValue>
                        {lab.kind === "life" ? "생활 사건" : "사용자 메시지"}
                      </PromptInputSelectValue>
                    </PromptInputSelectTrigger>
                    <PromptInputSelectContent>
                      <PromptInputSelectItem value="user">사용자 메시지</PromptInputSelectItem>
                      <PromptInputSelectItem value="life">생활 사건</PromptInputSelectItem>
                    </PromptInputSelectContent>
                  </PromptInputSelect>
                </div>
                <PromptInputSubmit
                  className="button button-primary"
                  disabled={!lab.current || !lab.text.trim() || lab.busy}
                >
                  {lab.busy ? "처리 중…" : "보내기"}
                </PromptInputSubmit>
              </div>
            </PromptInput>
            <p className="muted help">
              여러 번 나눠 보내도 됩니다. 보낸 메시지는 바로 나타나고 답장은 잠시 뒤 도착합니다.
              화면은 주기적으로 갱신되며, `시간 진행`을 누르면 다음 판단이 즉시 실행됩니다.
            </p>
            <p className="error" role="alert">
              {lab.error}
            </p>
          </div>
        </section>
        {lab.current && (
          <Observations
            current={lab.current}
            minutes={lab.minutes}
            setMinutes={lab.setMinutes}
            busy={lab.busy}
            changes={lab.changes}
            tick={lab.tick}
            triggerEvent={lab.triggerEvent}
            className="desktop-observations"
          />
        )}
      </main>
      <dialog className="observation-dialog" ref={observationDialog} aria-label="인물의 현재">
        <div className="drawer-header">
          <span>인물의 현재</span>
          <button
            className="button button-outline"
            type="button"
            onClick={() => observationDialog.current?.close()}
          >
            닫기
          </button>
        </div>
        {lab.current && (
          <Observations
            current={lab.current}
            minutes={lab.minutes}
            setMinutes={lab.setMinutes}
            busy={lab.busy}
            changes={lab.changes}
            tick={lab.tick}
            triggerEvent={lab.triggerEvent}
            titleId="mobile-state-title"
            className="mobile-observations-content"
          />
        )}
      </dialog>
    </div>
  );
};
