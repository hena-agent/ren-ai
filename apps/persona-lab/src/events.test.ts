import { expect, it } from "vitest";
import { eventFor } from "./events.ts";
import { admit, begin, decide } from "./loop.ts";
import { personas } from "./personas.ts";
import type { Judge, Judgment } from "./judge.ts";
import type { Model, Stage } from "@ren-ai/persona-engine";

const day = 24 * 60 * 60_000;
const model: Model = async () => ({ reply: "네.", changes: [] });
const choice =
  (shifts: Judgment["shifts"] = {}, stage: Stage = "stranger", eventReaction = false): Judge =>
  async () => ({
    action: "wait_for_user",
    probabilities: {},
    shifts,
    meaningfulAbsence: false,
    unitEnded: false,
    stage,
    eventReaction,
  });

const ready = (persona: "harin" | "jiwoo") => {
  const character = admit(
    begin(personas[persona]!, "test", 0),
    { id: "u1", kind: "user", text: "안녕하세요" },
    1_000,
  );
  character.session.stage = "acquaintance";
  character.session.events.push({ id: "r1", kind: "reply", text: "안녕하세요." });
  character.lastSentAt = 2_000;
  return character;
};

it("introduces an authored life event only after a conversation and a day of ordinary life", () => {
  const harin = ready("harin");
  const event = eventFor(harin, "harin", 1_000 + day);
  expect(event).toMatchObject({ id: "event:harin-exhibit", kind: "life" });
  expect(event?.text).toContain("사진전");
  expect(eventFor(ready("jiwoo"), "jiwoo", 1_000 + day)).toMatchObject({
    id: "event:jiwoo-presentation",
    kind: "life",
  });
  expect(eventFor(ready("jiwoo"), "jiwoo", 1_000 + day)?.text).toContain("팀 발표");
  for (const stage of ["familiar", "flirting"] as const) {
    const later = ready("harin");
    later.session.stage = stage;
    expect(eventFor(later, "harin", day + 1_000)?.id).toBe("event:harin-exhibit");
  }
  expect(eventFor(harin, "harin", 1_000 + day - 1)).toBeNull();
  expect(eventFor(harin, "missing", 1_000 + day)).toBeNull();
  harin.session.events.push(event!);
  expect(eventFor(harin, "harin", 1_000 + 2 * day)).toBeNull();
});

it("can immediately start an unused event for Lab testing, but not after it ends", () => {
  const character = begin(personas["harin"]!, "immediate", 0);
  expect(eventFor(character, "harin", 0)).toBeNull();
  const event = eventFor(character, "harin", 0, true);
  expect(event).toMatchObject({ id: "event:harin-exhibit", kind: "life" });
  expect(eventFor(character, "missing", 0, true)).toBeNull();
  const used = admit(character, event!, 0);
  expect(eventFor(used, "harin", 0, true)).toBeNull();
  character.session.stage = "ended";
  expect(eventFor(character, "harin", 0, true)).toBeNull();
});

it("waits until the persona has replied and no user message is pending", () => {
  const character = ready("harin");
  character.session.stage = "stranger";
  expect(eventFor(character, "harin", day + 1_000)).toBeNull();
  character.session.stage = "ended";
  expect(eventFor(character, "harin", day + 1_000)).toBeNull();
  character.session.stage = "familiar";
  character.lastSentAt = null;
  expect(eventFor(character, "harin", day + 1_000)).toBeNull();
  character.lastSentAt = 2_000;
  character.session.events.push({ id: "u2", kind: "user", text: "지금 뭐 해요?" });
  expect(eventFor(character, "harin", day + 1_000)).toBeNull();
  character.session.events.pop();
  character.session.events.push({ id: "l2", kind: "life", text: "전시 준비" });
  expect(eventFor(character, "harin", day + 1_000)?.id).toBe("event:harin-exhibit");
  character.entries[0] = { type: "input", event: character.session.events[0]! };
  expect(eventFor(character, "harin", day + 1_000)).toBeNull();
  character.entries = [];
  expect(eventFor(character, "harin", day + 1_000)).toBeNull();
});

it("anchors scheduling to the first user, not an earlier life event or transition", () => {
  const character = ready("harin");
  character.entries.unshift({
    type: "input",
    event: { id: "l0", kind: "life", text: "개인 일정" },
    at: 0,
  });
  expect(eventFor(character, "harin", day + 500)).toBeNull();
  expect(eventFor(character, "harin", day + 1_000)?.id).toBe("event:harin-exhibit");
  character.entries.unshift({ type: "transition", id: "t0", changes: [] });
  expect(eventFor(character, "harin", day + 1_000)?.id).toBe("event:harin-exhibit");
});

it("lets a meaningful reaction to a prepared event become a turning point, not the event itself", async () => {
  const character = begin(personas["harin"]!, "test", 0);
  character.session.stage = "familiar";
  character.session.relationship = { familiarity: 54, trust: 60, affection: 42 };
  const event = {
    id: "event:harin-exhibit",
    kind: "life",
    text: "사진전 설치를 앞두고 있다",
  } as const;
  const occurred = admit(admit(character, { id: "u1", kind: "user", text: "안녕" }), event, 1_000);
  expect(
    (
      await decide(
        occurred,
        "input",
        1_001,
        "no-user",
        choice({ "relationship.affection": "rise_clear" }, "familiar", true),
        model,
      )
    ).changes,
  ).toEqual([
    { kind: "relationship", field: "affection", value: 45, reason: "사건 event:harin-exhibit" },
  ]);
  const silence = await decide(
    occurred,
    "tick",
    1_001,
    "d0",
    choice({ "relationship.affection": "rise_clear" }),
    model,
  );
  expect(silence.changes).toEqual([]);
  const casual = admit(silence.character, { id: "u2", kind: "user", text: "안녕" }, 2_000);
  expect(
    (
      await decide(
        casual,
        "input",
        2_001,
        "unrelated",
        choice({ "relationship.affection": "rise_clear" }, "familiar"),
        model,
      )
    ).changes,
  ).toEqual([{ kind: "relationship", field: "affection", value: 45, reason: "사건 u2" }]);
  const unchanged = await decide(
    casual,
    "input",
    2_001,
    "d1",
    choice({ "condition.mood": "rise_slight", "relationship.affection": "rise_slight" }),
    model,
  );
  expect(unchanged.changes).toEqual([
    { kind: "condition", field: "mood", value: 56, reason: "사건 u2" },
    { kind: "relationship", field: "affection", value: 43, reason: "사건 u2" },
  ]);
  const shared = admit(unchanged.character, {
    id: "u3",
    kind: "user",
    text: "하린 씨가 오래 고민한 사진의 빈 공간이 저는 좋았어요",
  });
  const shifts = {
    "relationship.familiarity": "rise_clear",
    "relationship.trust": "rise_clear",
    "relationship.affection": "rise_clear",
  } as const;
  unchanged.character.decisions.at(-1)!.applied.push({
    kind: "condition",
    field: "mood",
    value: 56,
    reason: "전환점 event:harin-exhibit",
  });
  const moment = await decide(
    shared,
    "input",
    3_000,
    "d2",
    choice(shifts, "flirting", true),
    model,
  );
  expect(moment.changes).toEqual([
    { kind: "relationship", field: "familiarity", value: 66, reason: "전환점 event:harin-exhibit" },
    { kind: "relationship", field: "trust", value: 72, reason: "전환점 event:harin-exhibit" },
    { kind: "relationship", field: "affection", value: 55, reason: "전환점 event:harin-exhibit" },
    { kind: "stage", stage: "flirting", reason: "사건 u3" },
  ]);
  const next = admit(moment.character, { id: "u4", kind: "user", text: "다음에 봐요" });
  const repeated = await decide(
    next,
    "input",
    4_000,
    "d3",
    choice(shifts, "flirting", true),
    model,
  );
  expect(repeated.changes).toEqual([
    { kind: "relationship", field: "familiarity", value: 69, reason: "사건 u4" },
    { kind: "relationship", field: "trust", value: 75, reason: "사건 u4" },
    { kind: "relationship", field: "affection", value: 58, reason: "사건 u4" },
  ]);
  const atBoundary = admit(occurred, { id: "on-time", kind: "user", text: "전시 봤어요" });
  expect(
    (
      await decide(
        atBoundary,
        "input",
        day + 1_000,
        "boundary",
        choice(shifts, "flirting", true),
        model,
      )
    ).changes,
  ).toContainEqual({
    kind: "relationship",
    field: "affection",
    value: 54,
    reason: "전환점 event:harin-exhibit",
  });
});

it("does not reward an old event or an operator-entered life fact", async () => {
  const old = admit(
    begin(personas["harin"]!, "test", 0),
    { id: "event:harin-exhibit", kind: "life", text: "사진전" },
    1_000,
  );
  old.session.stage = "familiar";
  const late = admit(old, { id: "u1", kind: "user", text: "사진 어때요" });
  const shift = choice({ "relationship.affection": "rise_clear" }, "stranger", true);
  expect((await decide(late, "input", 1_000 + day + 1, "d1", shift, model)).changes).toEqual([
    { kind: "relationship", field: "affection", value: 18, reason: "사건 u1" },
  ]);
  const ordinary = admit(
    begin(personas["harin"]!, "test", 0),
    { id: "l1", kind: "life", text: "사진전" },
    1_000,
  );
  ordinary.session.stage = "familiar";
  const reacted = admit(ordinary, { id: "u1", kind: "user", text: "사진 어때요" });
  expect((await decide(reacted, "input", 2_000, "d2", shift, model)).changes).toEqual([
    { kind: "relationship", field: "affection", value: 18, reason: "사건 u1" },
  ]);
  const noTime = admit(begin(personas["harin"]!, "test", 0), {
    id: "event:harin-exhibit",
    kind: "life",
    text: "사진전",
  });
  const unanswered = admit(noTime, { id: "u1", kind: "user", text: "괜찮아요?" });
  expect((await decide(unanswered, "input", 2_000, "d3", shift, model)).changes).toEqual([
    { kind: "relationship", field: "affection", value: 18, reason: "사건 u1" },
  ]);
  const noEntry = begin(personas["harin"]!, "test", 0);
  noEntry.session.events.push({ id: "event:harin-exhibit", kind: "life", text: "사진전" });
  const withoutRecord = admit(noEntry, { id: "u1", kind: "user", text: "괜찮아요?" });
  expect((await decide(withoutRecord, "input", 2_000, "d4", shift, model)).changes).toEqual([
    { kind: "relationship", field: "affection", value: 18, reason: "사건 u1" },
  ]);
  expect(
    (await decide(begin(personas["harin"]!, "test", 0), "input", 2_000, "d5", shift, model))
      .changes,
  ).toEqual([{ kind: "relationship", field: "affection", value: 18, reason: "사건 d5" }]);
  const active = admit(
    begin(personas["harin"]!, "test", 0),
    { id: "event:harin-exhibit", kind: "life", text: "사진전" },
    1_000,
  );
  const spoofed = admit(active, { id: "event:spoof", kind: "user", text: "사진 봤어요" }, 2_000);
  expect((await decide(spoofed, "input", day + 1_001, "d6", shift, model)).changes).toEqual([
    { kind: "relationship", field: "affection", value: 18, reason: "사건 event:spoof" },
  ]);
  const withUnit = admit(active, { id: "u2", kind: "user", text: "사진 봤어요" });
  withUnit.entries.unshift({ type: "unit", id: "r0", reason: "대화 단위" });
  expect((await decide(withUnit, "input", 2_000, "d7", shift, model)).changes).toEqual([
    { kind: "relationship", field: "affection", value: 25, reason: "전환점 event:harin-exhibit" },
  ]);
});
