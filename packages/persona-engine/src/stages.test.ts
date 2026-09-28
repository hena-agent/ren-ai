import { expect, it } from "vitest";
import { canTransitionStage, capsFor, gateFor, STAGES, stageIndex } from "./index.ts";

const full = { familiarity: 100, trust: 100, affection: 100 };

it("orders the active ladder and treats ended as terminal", () => {
  expect(STAGES).toEqual(["stranger", "acquaintance", "familiar", "flirting", "dating", "ended"]);
  expect(stageIndex("stranger")).toBe(0);
  expect(stageIndex("acquaintance")).toBe(1);
  expect(stageIndex("familiar")).toBe(2);
  expect(stageIndex("flirting")).toBe(3);
  expect(stageIndex("dating")).toBe(4);
  expect(stageIndex("ended")).toBe(-1);
  expect(gateFor("stranger")).toEqual({ familiarity: 0, trust: 0, affection: 0 });
  expect(gateFor("acquaintance")).toEqual({ familiarity: 15, trust: 25, affection: 0 });
  expect(gateFor("familiar")).toEqual({ familiarity: 40, trust: 45, affection: 25 });
  expect(gateFor("flirting")).toEqual({ familiarity: 60, trust: 65, affection: 45 });
  expect(gateFor("dating")).toEqual({ familiarity: 80, trust: 80, affection: 70 });
  expect(gateFor("ended")).toEqual({ familiarity: 100, trust: 100, affection: 100 });
  expect(capsFor("stranger")).toEqual({ familiarity: 35, trust: 45, affection: 25 });
  expect(capsFor("acquaintance")).toEqual({ familiarity: 60, trust: 65, affection: 45 });
  expect(capsFor("familiar")).toEqual({ familiarity: 80, trust: 80, affection: 70 });
  expect(capsFor("flirting")).toEqual({ familiarity: 95, trust: 90, affection: 90 });
  expect(capsFor("dating")).toEqual({ familiarity: 100, trust: 100, affection: 100 });
  expect(capsFor("ended")).toEqual({ familiarity: 100, trust: 100, affection: 100 });
});

it("only advances one stage with the gate met", () => {
  expect(canTransitionStage("stranger", "stranger", full)).toBe(false);
  expect(canTransitionStage("stranger", "acquaintance", full)).toBe(true);
  expect(canTransitionStage("acquaintance", "familiar", full)).toBe(true);
  expect(canTransitionStage("familiar", "flirting", full)).toBe(true);
  expect(canTransitionStage("flirting", "dating", full)).toBe(true);
  expect(canTransitionStage("stranger", "familiar", full)).toBe(false);
  expect(canTransitionStage("acquaintance", "flirting", full)).toBe(false);
});

it("requires the exact gate values to advance", () => {
  expect(
    canTransitionStage("stranger", "acquaintance", { familiarity: 15, trust: 25, affection: 0 }),
  ).toBe(true);
  expect(
    canTransitionStage("stranger", "acquaintance", { familiarity: 14, trust: 25, affection: 0 }),
  ).toBe(false);
  expect(
    canTransitionStage("stranger", "acquaintance", { familiarity: 15, trust: 24, affection: 0 }),
  ).toBe(false);
  expect(
    canTransitionStage("acquaintance", "familiar", { familiarity: 40, trust: 45, affection: 24 }),
  ).toBe(false);
  expect(
    canTransitionStage("acquaintance", "familiar", { familiarity: 40, trust: 45, affection: 25 }),
  ).toBe(true);
});

it("steps down only in the early stages and ends from anywhere", () => {
  expect(canTransitionStage("acquaintance", "stranger", full)).toBe(true);
  expect(canTransitionStage("familiar", "acquaintance", full)).toBe(true);
  expect(canTransitionStage("flirting", "familiar", full)).toBe(false);
  expect(canTransitionStage("dating", "flirting", full)).toBe(false);
  for (const stage of ["stranger", "acquaintance", "familiar", "flirting", "dating"] as const)
    expect(canTransitionStage(stage, "ended", full)).toBe(true);
  expect(canTransitionStage("ended", "dating", full)).toBe(false);
  expect(canTransitionStage("ended", "stranger", full)).toBe(false);
  expect(canTransitionStage("ended", "ended", full)).toBe(false);
});
