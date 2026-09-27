import { expect, it } from "vitest";
import { applyTransition, createSession, recordInput } from "./index.ts";
import type { Change, Definition } from "./index.ts";

const definition: Definition = {
  name: "민",
  gender: "남성",
  profile: "조용한 화가",
  contactExpectation: "약속을 지킨다",
  hidden: [],
  mutable: { initiative: 23, guardedness: 63, openness: 31 },
  relationship: { affection: 5, trust: 7, familiarity: 0 },
  condition: { disappointment: 0, solitude: 42, connection: 45, stress: 13, energy: 77, mood: 51 },
  base: {
    novelty: 34,
    expression: 24,
    sensitivity: 87,
    initiative: 22,
    sociability: 34,
    autonomy: 62,
  },
};

it("applies a validated state transition without creating a reply", () => {
  const event = { id: "e1", kind: "user", text: "약속을 잊었어" } as const;
  const original = recordInput(createSession(definition, "min"), event);
  const progressed = applyTransition(original, [
    { kind: "mutable", field: "openness", value: 32, reason: "사건 e1" },
    { kind: "condition", field: "disappointment", value: 1, reason: "기대 변화" },
  ]);
  expect(original.mutable.openness).toBe(31);
  expect(progressed.mutable.openness).toBe(32);
  expect(progressed.condition.disappointment).toBe(1);
  expect(progressed.events).toEqual([event]);
  const trait = {
    id: "learned",
    name: "산책",
    strength: 31,
    context: "밤",
    scope: "personal" as const,
    persistence: "situational" as const,
    origin: "formed" as const,
    revealed: true,
    active: true,
    evidence: ["e1"],
    reason: "사건",
  };
  expect(applyTransition(original, [{ kind: "form", trait }]).traits.at(-1)?.evidence).toEqual([
    "e1",
  ]);
  expect(() =>
    applyTransition(original, [{ kind: "form", trait: { ...trait, evidence: ["foreign"] } }]),
  ).toThrow("Unknown evidence");
});

it("rejects invalid personality changes and incomplete identity", () => {
  for (const change of [
    { kind: "mutable", field: "openness", value: 101, reason: "x" },
    { kind: "mutable", field: "openness", value: 45, reason: "" },
  ] satisfies Change[])
    expect(() => applyTransition(createSession(definition, "min"), [change])).toThrow(
      /Stat|Invalid mutable change/,
    );
  const invalid = structuredClone({
    kind: "mutable",
    field: "openness",
    value: 45,
    reason: "x",
  } satisfies Change);
  Reflect.set(invalid, "field", "other");
  expect(() => applyTransition(createSession(definition, "min"), [invalid])).toThrow(
    "Invalid mutable change",
  );
  expect(() => createSession({ ...definition, gender: "" }, "min")).toThrow("identifiers");
  expect(() => createSession({ ...definition, contactExpectation: "" }, "min")).toThrow(
    "identifiers",
  );
  expect(() =>
    createSession({ ...definition, mutable: { ...definition.mutable, openness: -1 } }, "min"),
  ).toThrow("Stat");
});

it("starts at a chosen stage and enforces stage transitions and caps", () => {
  expect(createSession(definition, "min").stage).toBe("stranger");
  expect(createSession({ ...definition, startStage: "acquaintance" }, "min").stage).toBe(
    "acquaintance",
  );
  expect(() => createSession({ ...definition, startStage: "ended" }, "min")).toThrow(
    "Invalid start stage",
  );
  const bogusStart = structuredClone(definition);
  Reflect.set(bogusStart, "startStage", "bogus");
  expect(() => createSession(bogusStart, "min")).toThrow("Invalid start stage");

  expect(() =>
    applyTransition(createSession(definition, "min"), [
      { kind: "relationship", field: "affection", value: 26, reason: "상한 초과" },
    ]),
  ).toThrow("Relationship exceeds stage cap");
  expect(
    applyTransition(createSession(definition, "min"), [
      { kind: "relationship", field: "affection", value: 25, reason: "상한" },
    ]).relationship.affection,
  ).toBe(25);

  expect(() =>
    applyTransition(createSession(definition, "min"), [
      { kind: "stage", stage: "acquaintance", reason: "게이트 미달" },
    ]),
  ).toThrow("Invalid stage transition");
  const advanced = applyTransition(createSession(definition, "min"), [
    { kind: "relationship", field: "familiarity", value: 15, reason: "알아감" },
    { kind: "relationship", field: "trust", value: 25, reason: "신뢰" },
    { kind: "stage", stage: "acquaintance", reason: "알아가기 시작" },
  ]);
  expect(advanced.stage).toBe("acquaintance");
  expect(() =>
    applyTransition(advanced, [{ kind: "stage", stage: "flirting", reason: "건너뛰기" }]),
  ).toThrow("Invalid stage transition");
  expect(applyTransition(advanced, [{ kind: "stage", stage: "ended", reason: "종료" }]).stage).toBe(
    "ended",
  );
  expect(() =>
    applyTransition(advanced, [{ kind: "stage", stage: "stranger", reason: "" }]),
  ).toThrow("Invalid stage change");
  const bogusStage = structuredClone({
    kind: "stage",
    stage: "acquaintance",
    reason: "x",
  } satisfies Change);
  Reflect.set(bogusStage, "stage", "bogus");
  expect(() => applyTransition(createSession(definition, "min"), [bogusStage])).toThrow(
    "Invalid stage change",
  );
});
