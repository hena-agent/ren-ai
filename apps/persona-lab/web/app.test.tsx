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
    "기록 내려받기",
    "대화와 사건",
    "메시지 또는 실제 일어난 사건",
    "생활 사건",
    "보내기",
    "여러 번 나눠 보내도 됩니다.",
  ])
    expect(html).toContain(text);
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
  const side = renderToStaticMarkup(
    <Observations
      current={{ ...current, offset: 300_000 }}
      observedAt={31_000}
      minutes="5"
      setMinutes={() => undefined}
      tick={() => undefined}
      busy={false}
      changes="아직 변경이 없습니다."
    />,
  );
  for (const text of [
    "Private notes / 내부 관찰",
    new Date(331_000).toLocaleString(),
    "인물의 현재",
    "기본 특성",
    "현재 상태",
    "사건 기록",
    "시간 진행 →",
    "이번 턴의 변경 근거",
  ])
    expect(side).toContain(text);
});

it("separates the selected persona and session count without changing the native choices", () => {
  const html = renderToStaticMarkup(
    <ToolbarSelects
      persona="jiwoo"
      sessions={[{ id: "6713a5b2-0000", persona: "jiwoo", events: 11 }]}
      sessionId="6713a5b2-0000"
      busy={false}
      selectPersona={() => undefined}
      selectSession={() => undefined}
    />,
  );
  expect(html).toContain("지우 · 새 직장");
  expect(html).toContain("6713a5b2");
  expect(html).toContain("11건");
  expect(html).toContain('value="6713a5b2-0000"');
  expect(html).toContain("관찰할 인물");
});
