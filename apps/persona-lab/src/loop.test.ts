import { expect, it } from "vitest";
import { personas } from "./personas.ts";
import { admit, begin, decide } from "./loop.ts";
const INTERVAL_MS = 5 * 60_000;
import type { Action, Judge, Judgment } from "./judge.ts";
import type { Model, Stage } from "@repo/persona-engine";

const start = () => begin(personas["harin"]!, "harin", 1_000);
const choice =
  (
    action: Action,
    shifts: Judgment["shifts"] = {},
    meaningfulAbsence = false,
    stage: Stage = "stranger",
    unitEnded = false,
  ): Judge =>
  async () => ({
    action,
    probabilities: { [action]: 1 },
    shifts,
    meaningfulAbsence,
    unitEnded,
    stage,
  });
const model: Model = async () => ({
  reply: "늦게 봤어",
  changes: [],
});
const failure: Model = async () => Promise.reject(new Error("Gemini unavailable"));
const badJudge: Judge = async () => Promise.reject(new Error("Jev unavailable"));
const oddJudge: Judge = async () => Promise.reject("connection vanished");
const oddModel: Model = async () => Promise.reject("connection vanished");
const mutatingModel: Model = async () => ({
  reply: "잘 지냈어?",
  changes: [{ kind: "condition", field: "mood", value: 99, reason: "state change" }],
});
const user = { id: "u1", kind: "user", text: "안녕" } as const;
const inspectedJudge: Judge = async (context) => {
  expect(context.serviceBlocked).toBe(false);
  return {
    action: "wait_for_user",
    probabilities: {},
    shifts: { "condition.disappointment": "rise_slight" },
    meaningfulAbsence: true,
    unitEnded: false,
    stage: "stranger",
  };
};
const observedJudge: Judge = async (context) => {
  expect(context.previous[0]?.applied).toContain("reveal.reveal");
  return {
    action: "hold",
    probabilities: {},
    shifts: {},
    meaningfulAbsence: false,
    unitEnded: false,
    stage: "stranger",
  };
};
const capturing =
  (contexts: Array<Parameters<Judge>[0]>): Judge =>
  async (context) => {
    contexts.push(context);
    return {
      action: "wait_for_user",
      probabilities: {},
      shifts: {},
      meaningfulAbsence: false,
      unitEnded: false,
      stage: "stranger",
    };
  };

it("keeps unanswered messages while Jev chooses to wait or defer", async () => {
  const initial = start();
  expect(initial.nextCheckAt).toBe(1_000 + INTERVAL_MS);
  const admitted = admit(initial, user);
  expect(initial.session.events).toEqual([]);
  expect(admitted.session.events).toEqual([user]);
  expect(admitted.entries[0]).toStrictEqual({ type: "input", event: user });
  expect(admit(initial, user, 1_234).entries[0]).toEqual({
    type: "input",
    event: user,
    at: 1_234,
  });
  const waiting = await decide(
    admitted,
    "input",
    2_000,
    "d1",
    choice("wait_for_user", { "condition.mood": "fall_slight" }),
    model,
  );
  expect(waiting.decision).toMatchObject({
    requested: "wait_for_user",
    action: "wait_for_user",
    pendingIds: ["u1"],
    replyId: null,
  });
  expect(waiting.character.session.events).toEqual([user]);
  expect(waiting.changes).toEqual([
    { kind: "condition", field: "mood", value: 54, reason: "사건 u1" },
  ]);
  expect(waiting.character.session.condition.mood).toBe(54);
  expect(waiting.character.nextCheckAt).toBe(2_000 + INTERVAL_MS);
  const two = admit(waiting.character, { id: "u2", kind: "user", text: "사진 봤어?" });
  const later = await decide(
    two,
    "input",
    3_000,
    "d2",
    choice("hold", { "mutable.guardedness": "rise_slight" }),
    model,
  );
  expect(later.decision.pendingIds).toEqual(["u1", "u2"]);
  expect(later.character.session.events).toHaveLength(2);
  expect(later.changes).toEqual([
    { kind: "mutable", field: "guardedness", value: 66, reason: "사건 u2" },
  ]);
  expect(() => admit(two, user)).toThrow("duplicate input");
});

it("uses Gemini only after a Jev send decision, including spontaneous greetings", async () => {
  const admitted = admit(start(), user);
  const send = await decide(
    admitted,
    "input",
    2_000,
    "d1",
    choice("send_now", { "condition.mood": "rise_clear" }),
    model,
  );
  expect(send.character.session.events.at(-1)).toEqual({
    id: "d1:reply",
    kind: "reply",
    text: "늦게 봤어",
  });
  expect(send.character.session.condition.mood).toBe(58);
  expect(send.character.entries).toHaveLength(3);
  expect(send.character.session.events.at(-1)?.kind).toBe("reply");
  expect(send.character.lastSentAt).toBe(2_000);
  expect(send.changes).toEqual([
    { kind: "condition", field: "mood", value: 58, reason: "사건 u1" },
  ]);
  const greeting = await decide(start(), "tick", 301_000, "d2", choice("initiate"), model);
  expect(greeting.character.session.events).toHaveLength(1);
  expect(greeting.decision.replyId).toBe("d2:reply");
  expect(greeting.decision.action).toBe("initiate");
  const noPending = await decide(start(), "tick", 301_000, "d3", choice("send_now"), failure);
  expect(noPending.decision).toMatchObject({
    requested: "send_now",
    action: "wait_for_user",
    replyId: null,
  });
  const pendingInitiation = await decide(admitted, "input", 2_000, "d4", choice("initiate"), model);
  expect(pendingInitiation.decision).toMatchObject({ requested: "initiate", action: "send_now" });
});

it("records model and judge failures without losing admitted input or inventing a reply", async () => {
  const admitted = admit(start(), user);
  const modelFailure = await decide(admitted, "input", 2_000, "d1", choice("send_now"), failure);
  expect(modelFailure.decision).toMatchObject({
    requested: "send_now",
    action: "send_now",
    probabilities: { send_now: 1 },
    error: "Gemini unavailable",
    replyId: null,
  });
  expect(modelFailure.character.session.events).toEqual([user]);
  expect(modelFailure.changes).toEqual([]);
  expect(
    (await decide(admitted, "input", 5_000, "d-odd", choice("send_now"), oddModel)).decision.error,
  ).toBe("Generation failed");
  const rejected = await decide(
    admitted,
    "input",
    6_000,
    "d-change",
    choice("send_now", { "condition.mood": "rise_slight" }),
    mutatingModel,
  );
  expect(rejected.decision).toMatchObject({
    requested: "send_now",
    error: "Gemini cannot change state",
    applied: [{ kind: "condition", field: "mood", value: 56, reason: "사건 u1" }],
  });
  expect(rejected.character.session.condition.mood).toBe(56);
  expect(rejected.character.session.events).toEqual([user]);
  const afterOutage = await decide(
    modelFailure.character,
    "tick",
    2_000 + 1_800_000,
    "d-outage",
    choice(
      "wait_for_user",
      { "condition.disappointment": "rise_clear", "relationship.trust": "fall_clear" },
      true,
    ),
    model,
  );
  expect(afterOutage.changes).toEqual([]);
  const stillOut = await decide(
    afterOutage.character,
    "tick",
    2_000 + 7_200_000,
    "d-outage2",
    choice("wait_for_user", { "relationship.trust": "fall_clear" }, true),
    model,
  );
  expect(stillOut.changes).toEqual([]);
  const recovered = await decide(
    modelFailure.character,
    "tick",
    3_000,
    "d-recovered",
    choice("send_now"),
    model,
  );
  expect(recovered.character.lastSentAt).toBe(3_000);
  const resumed = await decide(
    recovered.character,
    "tick",
    3_000 + 1_800_000,
    "d-back",
    inspectedJudge,
    model,
  );
  expect(resumed.character.session.condition.disappointment).toBe(1);
  const newMessage = admit(recovered.character, { id: "u3", kind: "user", text: "다시" });
  const newlyFailed = await decide(
    newMessage,
    "input",
    4_000,
    "d-again",
    choice("send_now"),
    failure,
  );
  const blocked = await decide(
    newlyFailed.character,
    "tick",
    4_000 + 1_800_000,
    "d-blocked",
    choice("wait_for_user", { "relationship.trust": "fall_clear" }, true),
    model,
  );
  expect(blocked.changes).toEqual([]);
  const judgeFailure = await decide(modelFailure.character, "tick", 302_000, "d2", badJudge, model);
  expect(judgeFailure.decision).toMatchObject({
    requested: "error",
    action: "error",
    probabilities: {},
    error: "Jev unavailable",
    applied: [],
    meaningfulAbsence: false,
  });
  expect((await decide(admitted, "tick", 5_000, "d3", oddJudge, model)).decision.error).toBe(
    "Decision failed",
  );
  expect(judgeFailure.character.decisions).toHaveLength(2);
  expect(judgeFailure.character.nextCheckAt).toBe(302_000 + INTERVAL_MS);
  expect(judgeFailure.changes).toEqual([]);
  expect(() => admit(admitted, { id: "", kind: "user", text: "x" })).toThrow(
    "Invalid or duplicate input",
  );
  await expect(decide(admitted, "tick", 5_000, "", choice("hold"), model)).rejects.toThrow(
    "decision ID",
  );
  await expect(
    decide(judgeFailure.character, "tick", 5_000, "d2", choice("hold"), model),
  ).rejects.toThrow("decision ID");
});

it("changes state at most once in each meaningful silence window", async () => {
  const admitted = admit(start(), user);
  const initial = (await decide(admitted, "input", 2_000, "d0", choice("wait_for_user"), model))
    .character;
  const shift = choice(
    "wait_for_user",
    { "condition.mood": "fall_clear", "condition.disappointment": "rise_clear" },
    true,
  );
  const early = await decide(initial, "tick", 2_000 + 1_800_000 - 1, "d-early", shift, model);
  expect(early.decision.window).toBeNull();
  expect(early.changes).toEqual([]);
  const first = await decide(initial, "tick", 2_000 + 1_800_000, "d1", shift, model);
  expect(first.changes).toEqual([
    { kind: "condition", field: "mood", value: 54, reason: "시간 경과 2000:half_hour" },
    { kind: "condition", field: "disappointment", value: 1, reason: "시간 경과 2000:half_hour" },
  ]);
  const repeated = await decide(first.character, "tick", 2_000 + 2_100_000, "d2", shift, model);
  expect(repeated.changes).toEqual([]);
  const nearlyHours = await decide(
    repeated.character,
    "tick",
    2_000 + 7_200_000 - 1,
    "d-almost",
    shift,
    model,
  );
  expect(nearlyHours.decision.window).toBeNull();
  const hours = await decide(repeated.character, "tick", 2_000 + 7_200_000, "d3", shift, model);
  expect(hours.decision.window).toBe("2000:hours");
  const day = await decide(hours.character, "tick", 2_000 + 86_400_000, "d4", shift, model);
  expect(day.decision.window).toBe("2000:day");
  expect(day.character.session.condition.mood).toBe(52);
  const afterMessage = admit(day.character, { id: "u-late", kind: "user", text: "돌아왔어" });
  const messageDecision = await decide(
    afterMessage,
    "input",
    2_000 + 86_400_000 + 1,
    "d-message",
    shift,
    model,
  );
  expect(messageDecision.decision.window).toBeNull();
  const legacy = structuredClone(first.character);
  legacy.decisions[0]!.applied.push({
    kind: "reveal",
    traitId: "help",
    evidence: "u1",
    reason: "과거",
  });
  await decide(legacy, "tick", 2_000 + 86_400_000, "d5", observedJudge, model);
});

it("anchors absence to the latest reply rather than the older user message", async () => {
  const admitted = admit(start(), user);
  const early = await decide(admitted, "input", 2_000, "d0", choice("send_now"), model);
  const later = await decide(
    early.character,
    "tick",
    2_000 + 1_800_000 - 1,
    "d-before",
    choice("wait_for_user", { "condition.disappointment": "rise_clear" }, true),
    model,
  );
  expect(later.decision.window).toBeNull();
  const reached = await decide(
    later.character,
    "tick",
    2_000 + 1_800_000,
    "d-after",
    choice("wait_for_user", { "condition.disappointment": "rise_clear" }, true),
    model,
  );
  expect(reached.decision.window).toBe("2000:half_hour");
  expect(reached.character.session.condition.disappointment).toBe(1);
});

it("grounds delayed decisions in only unanswered user messages and the virtual clock", async () => {
  const observed: Array<{ ids: string[]; context: { id: string; kind: string; text: string } }> =
    [];
  const inspect: Model = async (state, context) => {
    observed.push({ ids: state.events.map((event) => event.id), context });
    return { reply: "오랜만이야", changes: [] };
  };
  const first = admit(start(), user);
  const replied = (await decide(first, "input", 2_000, "d1", choice("send_now"), inspect))
    .character;
  const next = admit(admit(replied, { id: "l1", kind: "life", text: "사진전을 마침" }), {
    id: "u2",
    kind: "user",
    text: "보고 싶었어",
  });
  const outcome = await decide(next, "tick", 302_000, "d2", choice("send_now"), inspect);
  expect(outcome.decision.pendingIds).toEqual(["u2"]);
  expect(observed[1]?.ids).toEqual(["u1", "d1:reply", "l1", "u2"]);
  expect(observed[1]?.context).toMatchObject({ id: "d2:reply", kind: "life" });
  expect(observed[1]?.context.text).toContain(new Date(302_000).toISOString());
  expect(outcome.character.entries.at(-1)?.type).toBe("reply");
});

it("never sends once the relationship has ended", async () => {
  const character = admit(start(), user);
  character.session.stage = "ended";
  const outcome = await decide(character, "input", 5_000, "d-ended", badJudge, oddModel);
  expect(outcome.decision).toMatchObject({
    requested: "wait_for_user",
    action: "wait_for_user",
    replyId: null,
    applied: [],
    meaningfulAbsence: false,
  });
  expect(outcome.decision).not.toHaveProperty("error");
  expect(outcome.character.nextCheckAt).toBe(5_000 + INTERVAL_MS);
  expect(outcome.character.session.events).toEqual([user]);
  expect(outcome.character.decisions).toEqual([outcome.decision]);
  expect(outcome.changes).toEqual([]);
});

it("records a stage change decided by Jev", async () => {
  const character = admit(start(), user);
  character.session.relationship.familiarity = 15;
  character.session.relationship.trust = 25;
  const stage = choice("wait_for_user", {}, false, "acquaintance");
  const outcome = await decide(character, "input", 5_000, "d-stage", stage, model);
  expect(outcome.character.session.stage).toBe("acquaintance");
  expect(outcome.decision.applied).toEqual([
    { kind: "stage", stage: "acquaintance", reason: "사건 u1" },
  ]);
});

it("passes the latest input time, pending messages and applied transitions to Jev", async () => {
  const contexts: Array<Parameters<Judge>[0]> = [];
  const admitted = admit(start(), user);
  const asked = await decide(
    admitted,
    "input",
    2_000,
    "d0",
    choice("hold", { "condition.mood": "fall_slight" }),
    model,
  );
  const ticked = await decide(
    asked.character,
    "tick",
    2_000 + 1_800_000,
    "d1",
    choice("wait_for_user"),
    model,
  );
  await decide(ticked.character, "tick", 2_000 + 3_600_000, "d2", capturing(contexts), model);
  expect(contexts[0]).toMatchObject({
    lastInputAt: 2_000,
    pending: [user],
    serviceBlocked: false,
  });
  expect(contexts[0]!.previous).toEqual([
    { at: 2_000, applied: ["condition.mood"] },
    { at: 2_000 + 1_800_000, applied: [] },
  ]);
});
