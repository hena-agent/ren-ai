import { describe, expect, it } from "vitest";
import { advance, createSession, emit, recordInput } from "./index.ts";
import type { Change, Definition, Model, Session, Trait } from "./index.ts";

const hidden: Trait = {
  id: "h1",
  name: "도움 요청 회피",
  strength: 80,
  context: "막혔을 때",
  scope: "personal",
  persistence: "lasting",
  origin: "hidden",
  revealed: false,
  active: true,
  evidence: [],
  reason: "혼자 해결하려 한다",
};
const definition: Definition = {
  name: "하린",
  profile: "독립적인 사진가",
  gender: "여성",
  contactExpectation: "약속을 지키길 바라지만 평소 연락은 천천히 기다린다",
  hidden: [hidden],
  relationship: { familiarity: 0, trust: 20, affection: 15 },
  base: {
    novelty: 65,
    expression: 40,
    sensitivity: 70,
    initiative: 25,
    sociability: 35,
    autonomy: 85,
  },
  condition: { solitude: 60, connection: 55, stress: 35, energy: 60, mood: 55, disappointment: 0 },
  mutable: { openness: 30, guardedness: 65, initiative: 25 },
};
const formed: Trait = {
  id: "f1",
  name: "비 오는 밤 산책",
  strength: 45,
  context: "비 오는 밤",
  scope: "relationship",
  persistence: "situational",
  origin: "formed",
  revealed: true,
  active: true,
  evidence: ["e1"],
  reason: "먼저 사진을 공유했다",
};
const input = { id: "e1", kind: "user", text: "비가 온다" } as const;
const fixed =
  (changes: Change[] = [], reply = "그래, 비가 오네"): Model =>
  async () => ({ reply, changes });
const start = (): Session => createSession(definition, "session-1");
const mutatingModel: Model = async (snapshot) => {
  snapshot.condition.mood = 0;
  return {
    reply: "안녕",
    changes: [
      { kind: "condition", field: "mood", value: 70, reason: "좋은 소식" },
      { kind: "relationship", field: "trust", value: 30, reason: "약속을 지킴" },
    ],
  };
};
const failingModel: Model = async () => {
  throw new Error("network unavailable");
};
const corrupt = <T extends object>(value: T, field: string, replacement: string): T => {
  const changed = structuredClone(value);
  Reflect.set(changed, field, replacement);
  return changed;
};

describe("Persona Engine", () => {
  it("starts with separate snapshots and never mutates the source", () => {
    const session = start();
    session.condition.mood = 2;
    session.traits[0]!.strength = 1;
    session.definition.base.autonomy = 1;
    expect(definition.condition.mood).toBe(55);
    expect(definition.hidden[0]!.strength).toBe(80);
    expect(start().definition.base.autonomy).toBe(85);
    expect(start().events).toEqual([]);
    expect(start().definition.base).toEqual(definition.base);
  });

  it("rejects an incomplete Persona, invalid initial scores and non-hidden initial traits", () => {
    expect(() => createSession(definition, "")).toThrow("identifiers");
    expect(() => createSession({ ...definition, name: "" }, "s")).toThrow("identifiers");
    expect(() => createSession({ ...definition, profile: "" }, "s")).toThrow("identifiers");
    expect(() =>
      createSession({ ...definition, base: { ...definition.base, autonomy: -1 } }, "s"),
    ).toThrow("Stat");
    expect(() =>
      createSession({ ...definition, base: { ...definition.base, autonomy: 100 } }, "s"),
    ).not.toThrow();
    expect(() =>
      createSession({ ...definition, condition: { ...definition.condition, mood: 101 } }, "s"),
    ).toThrow("Stat");
    expect(() =>
      createSession(
        { ...definition, relationship: { ...definition.relationship, trust: 1.5 } },
        "s",
      ),
    ).toThrow("Stat");
    expect(() =>
      createSession({ ...definition, hidden: [{ ...hidden, strength: 101 }] }, "s"),
    ).toThrow("Stat");
    for (const field of ["base", "condition", "relationship"] as const) {
      const incomplete = structuredClone(definition);
      Reflect.deleteProperty(incomplete[field], Object.keys(incomplete[field])[0]!);
      expect(() => createSession(incomplete, "s")).toThrow("Missing or unknown Stat");
    }
    const wrongField = structuredClone(definition);
    Reflect.deleteProperty(wrongField.base, "autonomy");
    Reflect.set(wrongField.base, "competitiveness", 85);
    expect(() => createSession(wrongField, "s")).toThrow("Missing or unknown Stat");
    const extraField = structuredClone(definition);
    Reflect.set(extraField.base, "competitiveness", 85);
    expect(() => createSession(extraField, "s")).toThrow("Missing or unknown Stat");
    for (const trait of [
      { ...hidden, origin: "formed" as const },
      { ...hidden, revealed: true },
      { ...hidden, active: false },
      { ...hidden, evidence: ["past"] },
      { ...hidden, id: "" },
      { ...hidden, name: "" },
      { ...hidden, context: "" },
      { ...hidden, reason: "" },
      corrupt(hidden, "scope", "invalid"),
      corrupt(hidden, "persistence", "invalid"),
    ])
      expect(() => createSession({ ...definition, hidden: [trait] }, "s")).toThrow("hidden");
    expect(() => createSession({ ...definition, hidden: [hidden, hidden] }, "s")).toThrow(
      "Duplicate",
    );
    expect(() =>
      createSession(
        {
          ...definition,
          hidden: [
            hidden,
            { ...hidden, id: "h2", scope: "relationship", persistence: "situational" },
          ],
        },
        "s",
      ),
    ).not.toThrow();
  });

  it("returns a new state and preserves the model input", async () => {
    const before = start();
    const turn = await advance(before, input, mutatingModel);
    expect(turn.state.condition.mood).toBe(70);
    expect(turn.state.relationship.trust).toBe(30);
    expect(turn.state.events.map((event) => event.id)).toEqual(["e1", "e1:reply"]);
    expect(turn.state.events[1]).toEqual({ id: "e1:reply", kind: "reply", text: "안녕" });
    expect(before.events).toEqual([]);
    expect(before.condition.mood).toBe(55);
    expect(turn.reply).toBe("안녕");
  });

  it("forms, reveals, revises and ends traits against recorded evidence", async () => {
    const first = await advance(
      start(),
      input,
      fixed([
        { kind: "form", trait: formed },
        { kind: "reveal", traitId: "h1", evidence: "e1:reply", reason: "도움 요청을 피했다" },
      ]),
    );
    expect(first.state.traits[0]!.revealed).toBe(true);
    expect(first.state.traits[0]!.evidence).toEqual(["e1:reply"]);
    expect(first.state.traits[1]).toEqual(formed);
    const second = await advance(
      first.state,
      { id: "e2", kind: "life", text: "혼자 산책했다" },
      fixed([
        {
          kind: "revise",
          traitId: "f1",
          strength: 65,
          persistence: "lasting",
          active: true,
          evidence: "e2",
          reason: "스스로 다시 선택",
        },
      ]),
    );
    expect(second.state.traits[1]!.persistence).toBe("lasting");
    expect(second.state.traits[1]!.evidence).toEqual(["e1", "e2"]);
    const recalled = await advance(
      second.state,
      { id: "e2b", kind: "life", text: "옛날 일을 떠올림" },
      fixed([
        {
          kind: "revise",
          traitId: "f1",
          strength: 66,
          persistence: "situational",
          active: true,
          evidence: "e1",
          reason: "첫날의 경험",
        },
      ]),
    );
    expect(recalled.state.traits[1]!.persistence).toBe("situational");
    expect(recalled.state.traits[1]!.evidence).toEqual(["e1", "e2", "e1"]);
    const third = await advance(
      second.state,
      { id: "e3", kind: "life", text: "흥미가 사라졌다" },
      fixed([
        {
          kind: "revise",
          traitId: "f1",
          strength: 10,
          persistence: "lasting",
          active: false,
          evidence: "e3",
          reason: "다시 찾지 않음",
        },
      ]),
    );
    expect(third.state.traits[1]!.active).toBe(false);
    expect(third.state.traits[1]!.evidence).toEqual(["e1", "e2", "e3"]);
  });

  it("rejects invalid input and reply IDs before calling a model", async () => {
    const session = start();
    for (const event of [
      { ...input, id: "" },
      { ...input, text: "" },
      { ...input, kind: "reply" as const },
    ])
      await expect(advance(session, event, fixed())).rejects.toThrow("input");
    const first = (await advance(session, input, fixed())).state;
    await expect(advance(first, input, fixed())).rejects.toThrow("duplicate input");
    const colliding = structuredClone(first);
    colliding.events.push({ id: "e2:reply", kind: "reply", text: "old" });
    await expect(advance(colliding, { ...input, id: "e2" }, fixed())).rejects.toThrow(
      "Duplicate reply ID",
    );
    await expect(advance(session, input, fixed([], ""))).rejects.toThrow("Empty reply");
    expect(session.events).toEqual([]);
  });

  it("rejects invalid Stat changes without committing earlier changes", async () => {
    for (const change of [
      { kind: "condition", field: "mood", value: 101, reason: "no" },
      corrupt(
        { kind: "condition", field: "mood", value: 50, reason: "no" } satisfies Change,
        "field",
        "missing",
      ),
      { kind: "condition", field: "mood", value: 50, reason: "" },
      { kind: "relationship", field: "trust", value: -1, reason: "no" },
      corrupt(
        { kind: "relationship", field: "trust", value: 50, reason: "no" } satisfies Change,
        "field",
        "missing",
      ),
      { kind: "relationship", field: "trust", value: 50, reason: "" },
    ] satisfies Change[]) {
      const session = start();
      await expect(
        advance(
          session,
          input,
          fixed([{ kind: "condition", field: "mood", value: 99, reason: "first" }, change]),
        ),
      ).rejects.toThrow(/./);
      expect(session.condition.mood).toBe(55);
      expect(session.events).toEqual([]);
    }
  });

  it("rejects malformed traits and nonexistent or cross-session evidence", async () => {
    const bad: Trait[] = [
      { ...formed, strength: 101 },
      { ...formed, id: "" },
      { ...formed, name: "" },
      { ...formed, reason: "" },
      { ...formed, context: "" },
      { ...formed, origin: "hidden" },
      { ...formed, revealed: false },
      { ...formed, active: false },
      corrupt(formed, "persistence", "invalid"),
      corrupt(formed, "scope", "invalid"),
      { ...formed, evidence: [] },
      { ...formed, evidence: ["other-session"] },
      { ...formed, id: "h1" },
    ];
    for (const trait of bad)
      await expect(advance(start(), input, fixed([{ kind: "form", trait }]))).rejects.toThrow(/./);
    const general = await advance(
      start(),
      input,
      fixed([{ kind: "form", trait: { ...formed, persistence: "lasting", scope: "personal" } }]),
    );
    expect(general.state.traits[1]?.persistence).toBe("lasting");
    expect(general.state.traits[1]?.scope).toBe("personal");
    for (const change of [
      { kind: "reveal", traitId: "h1", evidence: "other-session", reason: "x" },
      { kind: "reveal", traitId: "missing", evidence: "e1", reason: "x" },
      { kind: "reveal", traitId: "h1", evidence: "e1", reason: "" },
      {
        kind: "revise",
        traitId: "h1",
        evidence: "other-session",
        strength: 60,
        persistence: "lasting",
        active: true,
        reason: "x",
      },
      {
        kind: "revise",
        traitId: "missing",
        evidence: "e1",
        strength: 60,
        persistence: "lasting",
        active: true,
        reason: "x",
      },
      {
        kind: "revise",
        traitId: "h1",
        evidence: "e1",
        strength: 101,
        persistence: "lasting",
        active: true,
        reason: "x",
      },
      {
        kind: "revise",
        traitId: "h1",
        evidence: "e1",
        strength: 60,
        persistence: "lasting",
        active: true,
        reason: "",
      },
      corrupt(
        {
          kind: "revise",
          traitId: "h1",
          evidence: "e1",
          strength: 60,
          persistence: "lasting",
          active: true,
          reason: "x",
        } satisfies Change,
        "persistence",
        "invalid",
      ),
    ] satisfies Change[])
      await expect(advance(start(), input, fixed([change]))).rejects.toThrow(/./);
  });

  it("cannot reveal an already revealed or newly formed trait, or revise an ended trait", async () => {
    const revealed = (
      await advance(
        start(),
        input,
        fixed([
          { kind: "form", trait: formed },
          { kind: "reveal", traitId: "h1", evidence: "e1", reason: "noticed" },
        ]),
      )
    ).state;
    await expect(
      advance(
        revealed,
        { ...input, id: "e2" },
        fixed([{ kind: "reveal", traitId: "h1", evidence: "e2", reason: "again" }]),
      ),
    ).rejects.toThrow("not hidden");
    const unrevealedNew = structuredClone(revealed);
    unrevealedNew.traits[1]!.revealed = false;
    await expect(
      advance(
        unrevealedNew,
        { ...input, id: "e2" },
        fixed([{ kind: "reveal", traitId: "f1", evidence: "e2", reason: "not pre-existing" }]),
      ),
    ).rejects.toThrow("not hidden");
    await expect(
      advance(
        revealed,
        { ...input, id: "e2" },
        fixed([{ kind: "reveal", traitId: "f1", evidence: "e2", reason: "again" }]),
      ),
    ).rejects.toThrow("not hidden");
    await expect(
      advance(revealed, { ...input, id: "e2" }, fixed([{ kind: "form", trait: formed }])),
    ).rejects.toThrow("new trait");
    const ended = structuredClone(revealed);
    ended.traits[1]!.active = false;
    await expect(
      advance(
        ended,
        { ...input, id: "e2" },
        fixed([
          {
            kind: "revise",
            traitId: "f1",
            evidence: "e2",
            strength: 50,
            persistence: "lasting",
            active: true,
            reason: "again",
          },
        ]),
      ),
    ).rejects.toThrow("active trait");
  });

  it("keeps the state intact when the model fails", async () => {
    const session = start();
    await expect(advance(session, input, failingModel)).rejects.toThrow("network unavailable");
    expect(session.events).toEqual([]);
  });

  it("records user input without forcing a reply, then emits an independently justified reply", () => {
    const initial = start();
    const waiting = recordInput(initial, input);
    expect(initial.events).toEqual([]);
    expect(waiting.events).toEqual([input]);
    expect(
      recordInput(waiting, { id: "u2", kind: "user", text: "한 마디 더" }).events,
    ).toHaveLength(2);
    const turn = emit(waiting, "r1", {
      reply: "나중에 읽었어",
      changes: [{ kind: "form", trait: { ...formed, evidence: ["e1"] } }],
    });
    expect(turn.state.events).toEqual([input, { id: "r1", kind: "reply", text: "나중에 읽었어" }]);
    expect(turn.state.traits[1]!.evidence).toEqual(["e1"]);
    expect(waiting.traits).toHaveLength(1);
    expect(
      emit(waiting, "r2", {
        reply: "안녕",
        changes: [{ kind: "form", trait: { ...formed, evidence: ["r2"] } }],
      }).state.traits[1]!.evidence,
    ).toEqual(["r2"]);
  });

  it("rejects invalid asynchronous inputs and replies atomically", () => {
    const waiting = recordInput(start(), input);
    for (const candidate of [
      { ...input, id: "" },
      { ...input, text: "" },
      { ...input, id: "r2", kind: "reply" as const },
      input,
    ])
      expect(() => recordInput(waiting, candidate)).toThrow("Invalid or duplicate input");
    for (const [id, reply] of [
      ["", "hi"],
      ["e1", "hi"],
      ["r1", ""],
    ])
      expect(() => emit(waiting, id!, { reply: reply!, changes: [] })).toThrow(
        "Invalid or duplicate reply",
      );
    const multiple = recordInput(waiting, { id: "u2", kind: "user", text: "또 보냄" });
    expect(() => emit(multiple, "e1", { reply: "중복", changes: [] })).toThrow(
      "Invalid or duplicate reply",
    );
    expect(() =>
      emit(waiting, "r1", {
        reply: "hi",
        changes: [{ kind: "form", trait: { ...formed, evidence: ["foreign"] } }],
      }),
    ).toThrow("Unknown evidence");
    expect(waiting.events).toEqual([input]);
  });
});
