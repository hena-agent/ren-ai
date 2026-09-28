import { expect, it } from "vitest";
import { createSession } from "@ren-ai/persona-engine";
import { personas } from "./personas.ts";
import { transition } from "./transition.ts";
import type { Judgment } from "./judge.ts";

const state = () => createSession(personas["harin"]!, "harin");
const judgment = (
  shifts: Judgment["shifts"],
  meaningfulAbsence = false,
  stage: Judgment["stage"] = "stranger",
): Judgment => ({
  action: "wait_for_user",
  probabilities: {},
  shifts,
  meaningfulAbsence,
  unitEnded: false,
  stage,
});
it("applies evidence-backed message changes to mood, relationship and mutable personality", () => {
  const changes = transition({
    session: state(),
    judgment: judgment({
      "condition.mood": "fall_clear",
      "condition.disappointment": "rise_clear",
      "mutable.openness": "fall_slight",
      "relationship.trust": "fall_clear",
      "condition.energy": "stable",
    }),
    trigger: "input",
    sourceId: "u1",
    window: null,
    serviceBlocked: false,
  });
  expect(changes).toEqual([
    { kind: "condition", field: "mood", value: 52, reason: "사건 u1" },
    { kind: "condition", field: "disappointment", value: 3, reason: "사건 u1" },
    { kind: "mutable", field: "openness", value: 29, reason: "사건 u1" },
    { kind: "relationship", field: "trust", value: 17, reason: "사건 u1" },
  ]);
});

it("waits through ordinary five-minute ticks and never amplifies unsupported disappointment", () => {
  const params = {
    session: state(),
    judgment: judgment({
      "condition.mood": "fall_clear",
      "condition.disappointment": "rise_clear",
      "mutable.guardedness": "rise_clear",
      "relationship.affection": "fall_clear",
    }),
    trigger: "tick" as const,
    sourceId: "u1",
    serviceBlocked: false,
  };
  expect(transition({ ...params, window: null })).toEqual([]);
  expect(transition({ ...params, window: "1000:half_hour" })).toEqual([
    { kind: "condition", field: "mood", value: 54, reason: "시간 경과 1000:half_hour" },
  ]);
  expect(
    transition({
      ...params,
      judgment: judgment(params.judgment.shifts, true),
      window: "1000:half_hour",
      serviceBlocked: true,
    }),
  ).toEqual([{ kind: "condition", field: "mood", value: 54, reason: "시간 경과 1000:half_hour" }]);
  expect(
    transition({
      ...params,
      judgment: judgment(params.judgment.shifts, true),
      window: "1000:half_hour",
    }),
  ).toEqual([
    { kind: "condition", field: "mood", value: 54, reason: "시간 경과 1000:half_hour" },
    { kind: "condition", field: "disappointment", value: 1, reason: "시간 경과 1000:half_hour" },
    { kind: "mutable", field: "guardedness", value: 66, reason: "시간 경과 1000:half_hour" },
    { kind: "relationship", field: "affection", value: 14, reason: "시간 경과 1000:half_hour" },
  ]);
});

it("never escapes 0–100 or modifies immutable base temperament", () => {
  const session = state();
  session.condition.disappointment = 100;
  session.relationship.familiarity = 0;
  const changes = transition({
    session,
    judgment: judgment({
      "condition.disappointment": "rise_clear",
      "relationship.familiarity": "fall_clear",
      "mutable.initiative": "rise_slight",
    }),
    trigger: "input",
    sourceId: "u1",
    window: null,
    serviceBlocked: false,
  });
  expect(changes).toEqual([{ kind: "mutable", field: "initiative", value: 26, reason: "사건 u1" }]);
  expect(session.definition.base.initiative).toBe(25);
  session.mutable.initiative = 100;
  expect(
    transition({
      session,
      judgment: judgment({ "mutable.initiative": "rise_clear" }),
      trigger: "input",
      sourceId: "u2",
      window: null,
      serviceBlocked: false,
    }),
  ).toEqual([]);
});

it("clamps relationship growth to the current stage cap", () => {
  const session = state();
  session.relationship.affection = 24;
  expect(
    transition({
      session,
      judgment: judgment({ "relationship.affection": "rise_clear" }),
      trigger: "input",
      sourceId: "u1",
      window: null,
      serviceBlocked: false,
    }),
  ).toEqual([{ kind: "relationship", field: "affection", value: 25, reason: "사건 u1" }]);
  session.relationship.affection = 25;
  expect(
    transition({
      session,
      judgment: judgment({ "relationship.affection": "rise_clear" }),
      trigger: "input",
      sourceId: "u2",
      window: null,
      serviceBlocked: false,
    }),
  ).toEqual([]);
});

it("advances a stage only when the gate is met, applying stat changes first", () => {
  const atGate = state();
  atGate.relationship.familiarity = 14;
  atGate.relationship.trust = 25;
  expect(
    transition({
      session: atGate,
      judgment: judgment({ "relationship.familiarity": "rise_clear" }, false, "acquaintance"),
      trigger: "input",
      sourceId: "u1",
      window: null,
      serviceBlocked: false,
    }),
  ).toEqual([
    { kind: "relationship", field: "familiarity", value: 17, reason: "사건 u1" },
    { kind: "stage", stage: "acquaintance", reason: "사건 u1" },
  ]);
  expect(
    transition({
      session: state(),
      judgment: judgment({}, false, "acquaintance"),
      trigger: "input",
      sourceId: "u2",
      window: null,
      serviceBlocked: false,
    }),
  ).toEqual([]);
});

it("ignores skipped, out-of-order and time-only stage changes", () => {
  const rich = state();
  rich.relationship.familiarity = 100;
  rich.relationship.trust = 100;
  rich.relationship.affection = 100;
  const skip = transition({
    session: rich,
    judgment: judgment({}, false, "familiar"),
    trigger: "input",
    sourceId: "u1",
    window: null,
    serviceBlocked: false,
  });
  expect(skip).toEqual([]);
  rich.stage = "familiar";
  expect(
    transition({
      session: rich,
      judgment: judgment({}, false, "acquaintance"),
      trigger: "input",
      sourceId: "u2",
      window: null,
      serviceBlocked: false,
    }),
  ).toEqual([{ kind: "stage", stage: "acquaintance", reason: "사건 u2" }]);
  rich.stage = "flirting";
  expect(
    transition({
      session: rich,
      judgment: judgment({}, false, "familiar"),
      trigger: "input",
      sourceId: "u3",
      window: null,
      serviceBlocked: false,
    }),
  ).toEqual([]);
  rich.stage = "stranger";
  expect(
    transition({
      session: rich,
      judgment: judgment({}, false, "acquaintance"),
      trigger: "tick",
      sourceId: "u4",
      window: "1000:half_hour",
      serviceBlocked: false,
    }),
  ).toEqual([]);
  rich.stage = "flirting";
  expect(
    transition({
      session: rich,
      judgment: judgment({}, false, "ended"),
      trigger: "input",
      sourceId: "u5",
      window: null,
      serviceBlocked: false,
    }),
  ).toEqual([{ kind: "stage", stage: "ended", reason: "사건 u5" }]);
});

it("ignores an invalid step rather than applying an arbitrary state mutation", () => {
  const shifts = structuredClone({ "condition.mood": "stable" } satisfies Judgment["shifts"]);
  Reflect.set(shifts, "condition.mood", "surprise");
  expect(
    transition({
      session: state(),
      judgment: judgment(shifts),
      trigger: "input",
      sourceId: "u1",
      window: null,
      serviceBlocked: false,
    }),
  ).toEqual([]);
});
