import { describe, expect, it } from "vitest";
import { applyTransition, createSession, emit, parseChanges, recordInput } from "./index.ts";
import type { Definition } from "./index.ts";

const definition: Definition = {
  name: "테스트",
  profile: "단위 테스트용 인물",
  gender: "여성",
  contactExpectation: "기다린다",
  hidden: [],
  condition: { mood: 50, energy: 50, stress: 40, connection: 50, solitude: 50, disappointment: 0 },
  mutable: { openness: 40, guardedness: 40, initiative: 40 },
  base: {
    autonomy: 50,
    sociability: 50,
    initiative: 50,
    sensitivity: 50,
    expression: 50,
    novelty: 50,
  },
  relationship: { familiarity: 0, trust: 0, affection: 0 },
};

describe("conversation units", () => {
  it("starts at zero and marks a boundary after the events already recorded", () => {
    const initial = createSession(definition, "s");
    expect(initial.unitStart).toBe(0);
    const waiting = recordInput(initial, { id: "e1", kind: "user", text: "안녕" });
    const replied = emit(waiting, "r1", { reply: "응", changes: [] }).state;
    const marked = applyTransition(replied, [{ kind: "unit", reason: "대화 단위" }]);
    expect(marked.unitStart).toBe(2);
    expect(replied.unitStart).toBe(0);
    expect(initial.unitStart).toBe(0);
  });

  it("rejects a unit change without a reason", () => {
    expect(() =>
      applyTransition(createSession(definition, "s"), [{ kind: "unit", reason: "" }]),
    ).toThrow("Invalid unit change");
  });

  it("parses a unit change from stored or proposed JSON and rejects a missing reason", () => {
    expect(parseChanges([{ kind: "unit", reason: "대화 단위" }])).toEqual([
      { kind: "unit", reason: "대화 단위" },
    ]);
    expect(() => parseChanges([{ kind: "unit" }])).toThrow("Expected string");
  });
});
