import { useEffect, useRef, useState } from "react";
import type { Character } from "../src/loop.ts";
import { labels, stageLabels } from "./labels.ts";
import {
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
} from "./components/ai-elements/prompt-input.tsx";

const minuteChoices = [
  ["5", "5분"],
  ["30", "30분"],
  ["60", "1시간"],
  ["1440", "1일"],
] as const;

const Scores = ({ title, id, scores }: { title: string; id: string; scores: object }) => (
  <section className="observation-group">
    <h3>{title}</h3>
    <dl className="stats">
      {Object.entries(scores).map(([key, value]) => (
        <div className="stat" key={key}>
          <dt>
            {id === "mutable" && key === "initiative" ? "지금의 주도 의향" : (labels[key] ?? key)}
          </dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  </section>
);

export const Observations = ({
  current,
  minutes,
  setMinutes,
  tick,
  triggerEvent,
  busy,
  changes,
  titleId = "state-title",
  className = "",
}: {
  current: Character;
  minutes: string;
  setMinutes: (value: string) => void;
  tick: () => void;
  triggerEvent: () => void;
  busy: boolean;
  changes: string;
  titleId?: string;
  className?: string;
}) => {
  const { session } = current;
  const root = useRef<HTMLElement>(null);
  const [dialog, setDialog] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setDialog(root.current?.closest("dialog") ?? null);
  }, []);
  return (
    <aside ref={root} className={`side ${className}`} aria-labelledby={titleId}>
      <div className="side-heading">
        <p className="eyebrow">Private notes / 내부 관찰</p>
        <h2 id={titleId}>인물의 현재</h2>
        <p className="profile">{session.definition.profile}</p>
        <p className="stage">
          관계 단계 · {stageLabels[session.stage] ?? session.stage}
          {current.paused && " · 자동 판단 일시정지"}
        </p>
      </div>
      <div className="side-content">
        <Scores title="기본 특성" id="base" scores={session.definition.base} />
        <Scores title="가변 성격" id="mutable" scores={session.mutable} />
        <Scores title="현재 상태" id="condition" scores={session.condition} />
        <Scores title="이 사용자와의 관계" id="relationship" scores={session.relationship} />
        <section className="observation-group">
          <h3>숨겨진 면과 새로 생긴 특성</h3>
          {session.traits.map((trait) => (
            <div className="trait" key={trait.id}>
              <strong>
                {trait.name} · {trait.strength}
              </strong>
              <p>
                {trait.origin === "hidden" ? "원래 있던 면" : "새로 형성됨"} ·{" "}
                {trait.persistence === "lasting" ? "지속" : "상황 한정"} ·{" "}
                {trait.active ? "활성" : "종료"}
                {trait.revealed ? " · 드러남" : " · 숨겨짐"}
              </p>
              <small>
                상황: {trait.context} / 근거: {trait.evidence.join(", ") || "생성 시 설정"}
              </small>
            </div>
          ))}
        </section>
        <details className="observation-details">
          <summary>사건 기록</summary>
          <p className="record">
            {session.events.length
              ? session.events
                  .map((event) => `${event.id} · ${event.kind}: ${event.text}`)
                  .join("\n")
              : "아직 기록된 사건이 없습니다."}
          </p>
        </details>
        <section className="observation-group">
          <h3>시간과 판단</h3>
          <p className="muted">
            가상 시각: {new Date(Date.now() + current.offset).toLocaleString()} ·{" "}
            {current.paused
              ? "자동 판단: 일시정지"
              : `다음 판단: ${new Date(current.nextCheckAt).toLocaleString()}`}
          </p>
          <div className="tick-controls">
            <div className="select-field">
              <label htmlFor={`${titleId}-minutes`}>가상 시간 진행</label>
              <PromptInputSelect value={minutes} onValueChange={setMinutes} disabled={busy}>
                <PromptInputSelectTrigger id={`${titleId}-minutes`}>
                  <PromptInputSelectValue>
                    {minuteChoices.find(([value]) => value === minutes)?.[1] ?? minutes}
                  </PromptInputSelectValue>
                </PromptInputSelectTrigger>
                <PromptInputSelectContent container={dialog}>
                  {minuteChoices.map(([value, label]) => (
                    <PromptInputSelectItem key={value} value={value}>
                      {label}
                    </PromptInputSelectItem>
                  ))}
                </PromptInputSelectContent>
              </PromptInputSelect>
            </div>
            <button className="button button-outline" type="button" onClick={tick} disabled={busy}>
              시간 진행 →
            </button>
            <button
              className="button button-outline"
              type="button"
              onClick={triggerEvent}
              disabled={
                busy ||
                session.stage === "ended" ||
                session.events.some((event) => event.id.startsWith("event:"))
              }
            >
              이벤트 발생
            </button>
          </div>
          <p className="muted record">
            {current.decisions
              .toSorted((a, b) => b.at - a.at)
              .map(
                (decision) =>
                  `${new Date(decision.at).toLocaleString()} · ${decision.trigger} · Jev: ${decision.requested} → ${decision.action} · 확률 ${JSON.stringify(decision.probabilities)} · 적용 ${decision.applied.map((change) => `${change.kind}.${"field" in change ? change.field : "trait"}=${"value" in change ? change.value : "변경"}`).join(", ") || "없음"} · 대기 ${decision.pendingIds.length}${decision.error ? ` (${decision.error})` : ""}`,
              )
              .join("\n") || "아직 판단 기록이 없습니다."}
          </p>
        </section>
        <section className="observation-group">
          <h3>이번 턴의 변경 근거</h3>
          <p className="muted record" id="changes">
            {changes}
          </p>
        </section>
      </div>
    </aside>
  );
};
