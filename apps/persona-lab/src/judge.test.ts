import { expect, it } from "vitest";
import { createJudge, questions, stageGuidance } from "./judge.ts";
import { begin } from "./loop.ts";
import { personas } from "./personas.ts";

const context = () => ({
  session: begin(personas["harin"]!, "harin", 0).session,
  at: 12_000,
  trigger: "tick" as const,
  pending: [],
  lastSentAt: 1_000,
  lastInputAt: 2_000,
  previous: [{ at: 3_000, applied: ["condition.mood"] }],
  serviceBlocked: false,
});
const axisNames = Object.keys(questions).filter(
  (key) =>
    key !== "action" && key !== "meaningfulAbsence" && key !== "unitEnded" && key !== "stage",
);
const shifts = () => Object.fromEntries(axisNames.map((key) => [key, { choice: "stable" }]));
const valid = () => ({
  stage: { choice: "stranger" },
  action: { choice: "wait_for_user" },
  meaningfulAbsence: { probability: 0.1 },
  unitEnded: { probability: 0.1 },
  ...shifts(),
});

it("asks Jev to score every mutable dimension and the relationship stage", async () => {
  const input = context();
  input.session.events.push(
    ...Array.from({ length: 50 }, (_, index) => ({
      id: `u${index}`,
      kind: "user" as const,
      text: `message-${index}`,
    })),
  );
  let evaluated = "";
  const judge = createJudge(async (state, asked) => {
    evaluated = state;
    expect(Object.keys(asked)).toHaveLength(16);
    return {
      ...valid(),
      action: { choice: "hold", probabilities: { hold: 0.7, send_now: 0.3 } },
      meaningfulAbsence: { probability: 0.9 },
      "condition.disappointment": { choice: "rise_slight" },
    };
  });
  expect(await judge({ ...input, pending: [input.session.events[49]!] })).toEqual({
    action: "hold",
    probabilities: { hold: 0.7, send_now: 0.3 },
    shifts: {
      ...Object.fromEntries(axisNames.map((key) => [key, "stable"])),
      "condition.disappointment": "rise_slight",
    },
    meaningfulAbsence: true,
    unitEnded: false,
    stage: "stranger",
  });
  expect(evaluated).toContain("message-10");
  expect(evaluated).not.toContain("message-9");
  expect(evaluated).toContain('"pending":["message-49"]');
  expect(evaluated).toContain('"gender":"여성"');
  expect(evaluated).toContain('"stage":"stranger"');
  expect(evaluated).toContain('"serviceBlocked":false');
  expect(questions.stage.type).toBe("choice");
  const extended = {
    ...input,
    previous: Array.from({ length: 5 }, (_, index) => ({ at: index, applied: [`event-${index}`] })),
  };
  await judge(extended);
  expect(evaluated).toContain("event-2");
  expect(evaluated).not.toContain("event-1");
});

it("describes every stage for both Jev and Gemini", () => {
  const stages = ["stranger", "acquaintance", "familiar", "flirting", "dating", "ended"] as const;
  expect(Object.keys(stageGuidance).toSorted()).toEqual([...stages].toSorted());
  expect(Object.keys(questions.stage.criteria).toSorted()).toEqual([...stages].toSorted());
  for (const stage of stages) {
    expect(stageGuidance[stage].length).toBeGreaterThan(0);
    expect(questions.stage.criteria[stage].length).toBeGreaterThan(0);
  }
  expect(stageGuidance.stranger).toContain("just met");
  expect(stageGuidance.ended).toContain("do not contact");
  expect(questions.stage.criteria.ended).toContain("cannot be undone");
});

it("accepts any known stage and rejects unknown or missing stages", async () => {
  for (const stage of ["stranger", "acquaintance", "familiar", "flirting", "dating", "ended"])
    expect(
      (await createJudge(async () => ({ ...valid(), stage: { choice: stage } }))(context())).stage,
    ).toBe(stage);
  for (const stage of ["nonsense", ""])
    await expect(
      createJudge(async () => ({ ...valid(), stage: { choice: stage } }))(context()),
    ).rejects.toThrow("Invalid Jev stage");
  const missingStage = valid();
  Reflect.deleteProperty(missingStage, "stage");
  await expect(createJudge(async () => missingStage)(context())).rejects.toThrow(
    "Invalid Jev stage",
  );
  await expect(
    createJudge(async () => ({ ...valid(), stage: { probability: 0.5 } }))(context()),
  ).rejects.toThrow("Invalid Jev stage");
});

it("rejects missing or invalid Jev judgments, retaining stable as an explicit choice", async () => {
  expect(await createJudge(async () => valid())(context())).toMatchObject({
    action: "wait_for_user",
    probabilities: {},
    meaningfulAbsence: false,
    unitEnded: false,
    stage: "stranger",
  });
  const optional = valid();
  Reflect.set(optional.action, "probabilities", undefined);
  expect((await createJudge(async () => optional)(context())).probabilities).toEqual({});
  for (const action of ["send_now", "hold", "nudge", "wait_for_user", "initiate"]) {
    const result = await createJudge(async () => ({ ...valid(), action: { choice: action } }))(
      context(),
    );
    expect(result.action).toBe(action);
  }
  await expect(
    createJudge(async () => ({ ...valid(), action: { probability: 0.5 } }))(context()),
  ).rejects.toThrow("Invalid Jev judgment");
  for (const key of ["meaningfulAbsence", "unitEnded"] as const)
    for (const probability of [0, 1, 0.8])
      expect(
        (await createJudge(async () => ({ ...valid(), [key]: { probability } }))(context()))[key],
      ).toBe(probability >= 0.8);
  for (const answer of [
    { ...valid(), action: { choice: "spam" } },
    { ...valid(), meaningfulAbsence: { probability: 2 } },
    { ...valid(), meaningfulAbsence: { probability: -1 } },
    { ...valid(), meaningfulAbsence: { probability: Number.NaN } },
    { ...valid(), unitEnded: { probability: 2 } },
    { ...valid(), unitEnded: { probability: -1 } },
  ])
    await expect(createJudge(async () => answer)(context())).rejects.toThrow(
      "Invalid Jev judgment",
    );
  const missingUnit = valid();
  Reflect.deleteProperty(missingUnit, "unitEnded");
  await expect(createJudge(async () => missingUnit)(context())).rejects.toThrow(
    "Invalid Jev judgment",
  );
  const missing = valid();
  Reflect.deleteProperty(missing, "condition.mood");
  await expect(createJudge(async () => missing)(context())).rejects.toThrow(
    "Invalid Jev shift: condition.mood",
  );
  await expect(
    createJudge(async () => ({ ...valid(), "condition.mood": { choice: "nonsense" } }))(context()),
  ).rejects.toThrow("Invalid Jev shift: condition.mood");
  const missingAction = valid();
  Reflect.deleteProperty(missingAction, "action");
  await expect(createJudge(async () => missingAction)(context())).rejects.toThrow(
    "Invalid Jev judgment",
  );
});
