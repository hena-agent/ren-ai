import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { begin, admit } from "../src/loop.ts";
import { personas } from "../src/personas.ts";
import { App } from "./app.tsx";
import { Timeline } from "./timeline.tsx";
import { Observations } from "./observations.tsx";
import { ToolbarSelects } from "./toolbar-selects.tsx";

it("keeps the lab's actions and original guidance in the new layout", () => {
  const html = renderToStaticMarkup(<App />);
  for (const text of [
    "Persona Lab",
    "관찰할 인물",
    "새 세션",
    "기록 관리",
    "대화와 사건",
    "메시지 또는 실제 일어난 사건",
    "생활 사건",
    "보내기",
    "여러 번 나눠 보내도 됩니다.",
  ])
    expect(html).toContain(text);
  expect(html).toContain('for="input-kind-select"');
  expect(html).toContain('role="combobox"');
  expect(html).toContain('aria-haspopup="menu"');
  expect(html).toContain('aria-label="기록 불러오기"');
  expect(html).toContain('type="file"');
  expect(html).not.toContain("<summary");
  expect(html.match(/<button[^>]*>새 세션<\/button>/)?.[0]).not.toContain('disabled=""');
});

it("renders conversation events and the existing observation vocabulary", () => {
  const current = admit(
    begin(personas["harin"]!, "first", 1_000),
    { id: "note", kind: "life", text: "산책을 했다" },
    1_000,
  );
  const html = renderToStaticMarkup(<Timeline current={current} />);
  expect(html).toContain("생활 사건");
  expect(html).toContain("산책을 했다");
  current.offset = 300_000;
  const observations = (
    <Observations
      current={current}
      observedAt={31_000}
      minutes="5"
      setMinutes={() => undefined}
      tick={() => undefined}
      triggerEvent={() => undefined}
      busy={false}
      changes="아직 변경이 없습니다."
    />
  );
  const side = renderToStaticMarkup(observations);
  for (const text of [
    "Private notes / 내부 관찰",
    new Date(331_000).toLocaleString(),
    "인물의 현재",
    "기본 특성",
    "현재 상태",
    "사건 기록",
    "시간 진행 →",
    "이벤트 발생",
    "이번 턴의 변경 근거",
  ])
    expect(side).toContain(text);
  expect(side).toContain('for="state-title-minutes"');
  expect(side).toContain("5분");
  current.paused = true;
  expect(renderToStaticMarkup(observations)).toContain("자동 판단 일시정지");
  expect(side).toMatch(/<button[^>]*>이벤트 발생<\/button>/);
  current.session.events.push({ id: "event:harin-exhibit", kind: "life", text: "전시 준비" });
  expect(renderToStaticMarkup(observations)).toMatch(
    /<button[^>]*disabled=""[^>]*>이벤트 발생<\/button>/,
  );
  current.session.events.pop();
  current.session.stage = "ended";
  expect(renderToStaticMarkup(observations)).toMatch(
    /<button[^>]*disabled=""[^>]*>이벤트 발생<\/button>/,
  );
});

it("shows judgment history in descending timestamp order", () => {
  const current = begin(personas["harin"]!, "sorted", 1_000);
  const decision = {
    trigger: "tick" as const,
    requested: "wait_for_user" as const,
    action: "wait_for_user" as const,
    probabilities: {},
    pendingIds: [],
    shifts: {},
    applied: [],
    meaningfulAbsence: false,
    window: null,
    replyId: null,
  };
  current.decisions.push(
    { ...decision, id: "middle", at: 2_000, error: "중간 판단" },
    { ...decision, id: "old", at: 1_000, error: "오래된 판단" },
    { ...decision, id: "new", at: 3_000, error: "최근 판단" },
  );
  const html = renderToStaticMarkup(
    <Observations
      current={current}
      observedAt={31_000}
      minutes="5"
      setMinutes={() => undefined}
      tick={() => undefined}
      triggerEvent={() => undefined}
      busy={false}
      changes="없음"
    />,
  );
  expect(html.indexOf("최근 판단")).toBeLessThan(html.indexOf("중간 판단"));
  expect(html.indexOf("중간 판단")).toBeLessThan(html.indexOf("오래된 판단"));
  expect(current.decisions.map((entry) => entry.id)).toEqual(["middle", "old", "new"]);
});

it("labels the selected persona and session in accessible comboboxes", () => {
  const html = renderToStaticMarkup(
    <ToolbarSelects
      persona="jiwoo"
      sessions={[{ id: "6713a5b2-0000", persona: "jiwoo", events: 11, paused: false }]}
      sessionId="6713a5b2-0000"
      busy={false}
      selectPersona={() => undefined}
      selectSession={() => undefined}
    />,
  );
  expect(html).toContain("지우 · 새 직장");
  expect(html).toContain("6713a5b2");
  expect(html).toContain("11건");
  expect(html).toContain('for="persona-select"');
  expect(html).toContain('for="session-select"');
  expect(html).toContain('role="combobox"');
  expect(html).toContain("관찰할 인물");
  const disabled = renderToStaticMarkup(
    <ToolbarSelects
      persona="jiwoo"
      sessions={[]}
      sessionId=""
      busy={true}
      selectPersona={() => undefined}
      selectSession={() => undefined}
    />,
  );
  const triggers = [...disabled.matchAll(/<button\b[^>]*role="combobox"[^>]*>/g)];
  expect(triggers).toHaveLength(2);
  expect(triggers.every(([button]) => button.includes('disabled=""'))).toBe(true);
  const paused = renderToStaticMarkup(
    <ToolbarSelects
      persona="jiwoo"
      sessions={[{ id: "6713a5b2-0000", persona: "jiwoo", events: 11, paused: true }]}
      sessionId="6713a5b2-0000"
      busy={false}
      selectPersona={() => undefined}
      selectSession={() => undefined}
    />,
  );
  expect(paused).toContain("일시정지");
});
