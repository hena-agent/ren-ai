import { expect, it } from "vitest";
import type { Model } from "@repo/persona-engine";
import type { Judge } from "./judge.ts";
import { ABSORB_MS, admit, begin, decide } from "./loop.ts";
import type { Character, Decision } from "./loop.ts";
import { personas } from "./personas.ts";

const INTERVAL_MS = 5 * 60_000;
const user = { id: "u1", kind: "user", text: "안녕" } as const;
const start = () => begin(personas["harin"]!, "harin", 1_000);
const intent =
  (action: "hold" | "nudge" | "send_now"): Judge =>
  async () => ({
    action,
    probabilities: { [action]: 1 },
    shifts: {},
    meaningfulAbsence: false,
    unitEnded: false,
    stage: "stranger",
  });
const model: Model = async () => ({ reply: "늦게 봤어", changes: [] });
const failure: Model = async () => Promise.reject(new Error("Gemini unavailable"));
const waiting: Judge = async () => ({
  action: "wait_for_user",
  probabilities: {},
  shifts: {},
  meaningfulAbsence: false,
  unitEnded: false,
  stage: "stranger",
});
const decision = (patch: Partial<Decision>): Decision => ({
  id: "d",
  at: 0,
  trigger: "tick",
  requested: "hold",
  action: "hold",
  probabilities: {},
  pendingIds: [],
  shifts: {},
  applied: [],
  meaningfulAbsence: false,
  window: null,
  replyId: null,
  ...patch,
});
const crafted = (lastSentAt: number | null, windows: Array<string | null> = []): Character => {
  const character = begin(personas["harin"]!, "harin", 0);
  character.lastSentAt = lastSentAt;
  for (const [index, window] of windows.entries())
    character.decisions.push(decision({ id: `w${index}`, at: index, window }));
  return character;
};

it("holds briefly with a pending message and nudges only after an earlier send", async () => {
  const admitted = admit(start(), user);
  const held = await decide(admitted, "input", 2_000, "d-hold", intent("hold"), failure);
  expect(held.decision).toMatchObject({ requested: "hold", action: "hold", replyId: null });
  expect(held.character.nextCheckAt).toBe(2_000 + ABSORB_MS);
  expect(held.character.session.events).toEqual([user]);
  const idle = await decide(start(), "tick", 301_000, "d-idle", intent("hold"), failure);
  expect(idle.decision).toMatchObject({ action: "wait_for_user", replyId: null });
  expect(idle.character.nextCheckAt).toBe(301_000 + INTERVAL_MS);
  const noPrior = await decide(start(), "tick", 301_000, "d-noprior", intent("nudge"), failure);
  expect(noPrior.decision).toMatchObject({ action: "wait_for_user", replyId: null });
  const sent = await decide(admitted, "input", 2_000, "d-send", intent("send_now"), model);
  const nudged = await decide(
    sent.character,
    "tick",
    2_000 + INTERVAL_MS,
    "d-nudge",
    intent("nudge"),
    model,
  );
  expect(nudged.decision).toMatchObject({ action: "nudge", replyId: "d-nudge:reply" });
  expect(nudged.character.nextCheckAt).toBe(2_000 + INTERVAL_MS + INTERVAL_MS);
  const bundled = await decide(admitted, "input", 2_000, "d-bundle", intent("nudge"), model);
  expect(bundled.decision).toMatchObject({ requested: "nudge", action: "send_now" });
});

it("computes silence windows from the latest contact, never reusing a window on a message", async () => {
  const cases: Array<
    [number | null, Array<string | null>, "input" | "tick", number, string | null]
  > = [
    [null, [], "tick", 1_000, null],
    [null, [], "tick", 2_000_000, null],
    [5_400_000, [], "tick", 7_200_000, "5400000:half_hour"],
    [5_400_000, ["5400000:half_hour"], "tick", 7_200_000, null],
    [5_400_000, [], "input", 7_200_000, null],
    [1_000, [], "tick", 1_800_999, null],
    [1_000, [], "tick", 1_801_000, "1000:half_hour"],
    [1_000, [], "tick", 7_201_000, "1000:hours"],
    [1_000, [], "tick", 86_401_000, "1000:day"],
  ];
  for (const [lastSentAt, windows, trigger, at, expected] of cases) {
    const outcome = await decide(
      crafted(lastSentAt, windows),
      trigger,
      at,
      `d-${at}-${trigger}`,
      waiting,
      model,
    );
    expect(outcome.decision.window).toBe(expected);
  }
});

it("flags an unanswered failure as a service block and clears it after a later reply", async () => {
  const cases: Array<[number | null, number, boolean]> = [
    [null, 0, true],
    [null, 50, true],
    [50, 50, false],
    [40, 50, true],
  ];
  for (const [lastSentAt, errorAt, expected] of cases) {
    const character = crafted(lastSentAt);
    character.decisions.push(
      decision({
        id: "err",
        at: errorAt,
        trigger: "input",
        requested: "error",
        action: "error",
        error: "boom",
      }),
    );
    const contexts: Array<Parameters<Judge>[0]> = [];
    const capturing: Judge = async (context) => {
      contexts.push(context);
      return waiting(context);
    };
    await decide(character, "tick", 100_000, `d-${errorAt}-${lastSentAt}`, capturing, model);
    expect(contexts[0]!.serviceBlocked).toBe(expected);
  }
});
