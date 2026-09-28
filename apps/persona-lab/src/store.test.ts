import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, restore } from "./store.ts";
import { admit, begin, decide } from "./loop.ts";
import { personas } from "./personas.ts";
import { eventFor } from "./events.ts";
import type { Judge } from "./judge.ts";
import type { Model } from "@ren-ai/persona-engine";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "persona-lab-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const judge: Judge = async () => ({
  action: "send_now",
  probabilities: { send_now: 1 },
  shifts: { "condition.mood": "rise_clear" },
  meaningfulAbsence: false,
  unitEnded: false,
  stage: "stranger",
});
const model: Model = async () => ({
  reply: "안녕",
  changes: [],
});
const raiser: Judge = async () => ({
  action: "wait_for_user",
  probabilities: {},
  shifts: { "relationship.familiarity": "rise_clear", "relationship.trust": "rise_clear" },
  meaningfulAbsence: false,
  unitEnded: false,
  stage: "stranger",
});
const staged: Judge = async () => ({
  action: "wait_for_user",
  probabilities: {},
  shifts: {},
  meaningfulAbsence: false,
  unitEnded: false,
  stage: "acquaintance",
});

it("saves a Character atomically and rebuilds the same state from its events", async () => {
  const store = createStore(dir);
  expect(await store.load("harin")).toBeUndefined();
  const input = admit(
    begin(personas["harin"]!, "harin", 100),
    { id: "u1", kind: "user", text: "안녕" },
    123,
  );
  const outcome = await decide(input, "input", 200, "d1", judge, model);
  await store.save("harin", outcome.character);
  const fresh = createStore(dir);
  expect(await fresh.load("harin")).toEqual({ persona: "harin", character: outcome.character });
  expect((await fresh.load("harin"))?.character.entries[0]).toMatchObject({ at: 123 });
  expect(await readFile(join(dir, "harin.json"), "utf8")).toContain('"decisions"');
  expect(await fresh.load("unknown")).toBeUndefined();
  expect(() => restore("unknown", "s1", {})).toThrow("Unknown Persona");
  await expect(fresh.save("unknown", outcome.character)).rejects.toThrow("Unknown Persona");
});

it("replays a stage change from its recorded entries", async () => {
  const store = createStore(dir);
  let character = begin(personas["harin"]!, "harin", 100);
  for (let index = 0; index < 5; index++) {
    character = admit(character, { id: `u${index}`, kind: "user", text: "안녕" });
    character = (await decide(character, "input", 200 + index, `d${index}`, raiser, model))
      .character;
  }
  character = admit(character, { id: "u5", kind: "user", text: "더" });
  const outcome = await decide(character, "input", 300, "d5", staged, model);
  expect(outcome.character.session.stage).toBe("acquaintance");
  await store.save("harin", outcome.character);
  const restored = await createStore(dir).load("harin");
  expect(restored?.character.session.stage).toBe("acquaintance");
  expect(restored?.character).toEqual(outcome.character);
  expect(restored?.persona).toBe("harin");
  const event = {
    id: "event:harin-exhibit",
    kind: "life",
    text: "사진전을 설치할 준비를 한다",
  } as const;
  const continued = admit(outcome.character, event, 400);
  await store.save("harin", continued);
  const reloaded = (await createStore(dir).load("harin"))!.character;
  expect(reloaded.session.events.at(-1)).toEqual(event);
  expect(eventFor(reloaded, "harin", 400 + 86_400_000)).toBeNull();
});

it("rejects a saved record whose persona is not a name", async () => {
  const store = createStore(dir);
  await writeFile(
    join(dir, "bad.json"),
    JSON.stringify({
      persona: 5,
      entries: [],
      decisions: [],
      nextCheckAt: 1,
      offset: 0,
      lastSentAt: null,
    }),
  );
  await expect(store.load("bad")).rejects.toThrow("Invalid saved Character");
});

it("lists stored sessions and tolerates missing or unreadable directories", async () => {
  expect(await createStore(join(dir, "none")).list()).toEqual([]);
  const store = createStore(dir);
  await store.save("harin", begin(personas["harin"]!, "s-list", 100));
  expect(await store.list()).toEqual([
    { id: "s-list", persona: "harin", events: 0, paused: false },
  ]);
  await writeFile(join(dir, "afile"), "x");
  await expect(createStore(join(dir, "afile")).list()).rejects.toMatchObject({
    code: "ENOTDIR",
  });
});

it("rejects corrupted snapshots instead of passing them to the engine", async () => {
  const store = createStore(dir);
  await store.save("harin", begin(personas["harin"]!, "harin", 100));
  const path = join(dir, "harin.json");
  for (const sample of [
    "not json",
    "null",
    "[]",
    "{}",
    JSON.stringify({
      entries: [],
      decisions: [],
      nextCheckAt: "later",
      offset: 0,
      lastSentAt: null,
    }),
    JSON.stringify({
      entries: [{ type: "unknown" }],
      decisions: [],
      nextCheckAt: 1,
      offset: 0,
      lastSentAt: null,
    }),
    JSON.stringify({
      entries: [{ type: "input", event: { id: "u1", kind: "reply", text: "x" } }],
      decisions: [],
      nextCheckAt: 1,
      offset: 0,
      lastSentAt: null,
    }),
    JSON.stringify({ entries: [], decisions: [{}], nextCheckAt: 1, offset: 0, lastSentAt: null }),
    JSON.stringify({
      entries: [],
      decisions: [
        {
          id: "d1",
          at: 1,
          trigger: "tick",
          requested: "hold",
          action: "hold",
          pendingIds: [],
          replyId: null,
          probabilities: { hold: 2 },
          shifts: {},
          applied: [],
          meaningfulAbsence: false,
          window: null,
        },
      ],
      nextCheckAt: 1,
      offset: 0,
      lastSentAt: null,
    }),
    JSON.stringify({
      entries: [],
      decisions: [
        {
          id: "d1",
          at: 1,
          trigger: "tick",
          requested: "hold",
          action: "hold",
          pendingIds: [],
          replyId: null,
          probabilities: {},
          shifts: {},
          applied: [],
          meaningfulAbsence: false,
          window: null,
          error: 3,
        },
      ],
      nextCheckAt: 1,
      offset: 0,
      lastSentAt: null,
    }),
  ]) {
    await writeFile(path, sample);
    await expect(store.load("harin")).rejects.toThrow(sample === "not json" ? SyntaxError : Error);
  }
  expect(() => restore("missing", "s1", {})).toThrow("Unknown Persona");
  await writeFile(join(dir, "not-a-directory"), "file");
  await expect(createStore(join(dir, "not-a-directory")).load("harin")).rejects.toMatchObject({
    code: "ENOTDIR",
  });
});

it("validates every persisted event and decision before replay", () => {
  const base = { entries: [], decisions: [], nextCheckAt: 1, offset: 0, lastSentAt: null };
  for (const value of [null, 2, "x", []])
    expect(() => restore("harin", "harin", value)).toThrow("Invalid saved record");
  expect(() => restore("harin", "harin", {})).toThrow("Invalid saved Character");
  for (const patch of [
    { entries: "wrong" },
    { decisions: "wrong" },
    { nextCheckAt: "wrong" },
    { offset: "wrong" },
    { lastSentAt: "wrong" },
  ])
    expect(() => restore("harin", "harin", { ...base, ...patch })).toThrow(
      "Invalid saved Character",
    );
  for (const event of [
    null,
    "bad",
    [],
    {},
    { id: 4, kind: "user", text: "x" },
    { id: "u1", kind: "user", text: 4 },
    { id: "u1", kind: "reply", text: "x" },
  ])
    expect(() =>
      restore("harin", "harin", { ...base, entries: [{ type: "input", event }] }),
    ).toThrow(/Invalid saved (record|input)/);
  expect(
    restore("harin", "harin", {
      ...base,
      entries: [{ type: "input", event: { id: "l1", kind: "life", text: "산책" } }],
    }).session.events[0]?.kind,
  ).toBe("life");
  for (const entry of [
    null,
    5,
    {},
    { type: "other", id: "r1", proposal: { reply: "x", changes: [] } },
    { type: "other", id: "r1", reason: "x" },
    { type: "reply", id: 4, proposal: { reply: "x", changes: [] } },
    { type: "transition", id: 4, changes: [] },
  ])
    expect(() => restore("harin", "harin", { ...base, entries: [entry] })).toThrow(
      /Invalid saved (record|entry)/,
    );

  const decision = {
    id: "d1",
    at: 4,
    trigger: "tick",
    requested: "hold",
    action: "hold",
    pendingIds: [],
    replyId: null,
    probabilities: {},
    shifts: {},
    applied: [],
    meaningfulAbsence: false,
    window: null,
  };
  for (const patch of [
    { id: 4 },
    { at: "bad" },
    { trigger: "other" },
    { requested: "other" },
    { action: "other" },
    { pendingIds: "bad" },
    { pendingIds: [4] },
    { replyId: 4 },
  ])
    expect(() =>
      restore("harin", "harin", { ...base, decisions: [{ ...decision, ...patch }] }),
    ).toThrow("Invalid saved decision");
  for (const probability of ["bad", -1, 1.01])
    expect(() =>
      restore("harin", "harin", {
        ...base,
        decisions: [{ ...decision, probabilities: { hold: probability } }],
      }),
    ).toThrow("Invalid saved probabilities");
  for (const patch of [{ meaningfulAbsence: "bad" }, { window: 4 }])
    expect(() =>
      restore("harin", "harin", { ...base, decisions: [{ ...decision, ...patch }] }),
    ).toThrow("Invalid saved transition");
  expect(() =>
    restore("harin", "harin", {
      ...base,
      decisions: [{ ...decision, shifts: { "condition.mood": "invalid" } }],
    }),
  ).toThrow("Invalid saved shifts");
  for (const step of ["fall_clear", "fall_slight", "stable", "rise_slight", "rise_clear"])
    expect(
      restore("harin", "harin", {
        ...base,
        decisions: [{ ...decision, shifts: { "condition.mood": step }, window: "4:half_hour" }],
      }).decisions[0],
    ).toMatchObject({ shifts: { "condition.mood": step }, window: "4:half_hour" });
  expect(() =>
    restore("harin", "harin", { ...base, decisions: [{ ...decision, applied: "invalid" }] }),
  ).toThrow("Expected changes array");
  expect(
    restore("harin", "harin", {
      ...base,
      decisions: [{ ...decision, probabilities: { hold: 0, send_now: 1 }, error: "retry" }],
    }).decisions[0],
  ).toEqual({ ...decision, error: "retry", probabilities: { hold: 0, send_now: 1 } });
  expect(
    restore("harin", "harin", { ...base, decisions: [decision] }).decisions[0],
  ).not.toHaveProperty("error");
  expect(() =>
    restore("harin", "harin", { ...base, decisions: [{ ...decision, error: 5 }] }),
  ).toThrow("Invalid saved error");
});

it("replays a saved unit boundary and rejects a blank or foreign reason", () => {
  const base = { decisions: [], nextCheckAt: 1, offset: 0, lastSentAt: null };
  const input = { type: "input", event: { id: "e1", kind: "user", text: "안녕" } };
  const entries = [input, { type: "unit", id: "e1:reply", reason: "대화 단위" }];
  const restored = restore("harin", "harin", { ...base, entries });
  expect(restored.session.unitStart).toBe(1);
  expect(restored.entries).toEqual(entries);
  for (const reason of ["", 4])
    expect(() =>
      restore("harin", "harin", {
        ...base,
        entries: [{ type: "unit", id: "r1", reason }],
      }),
    ).toThrow("Invalid saved entry");
  expect(() =>
    restore("harin", "harin", {
      ...base,
      entries: [{ type: "unit", id: 4, reason: "대화 단위" }],
    }),
  ).toThrow("Invalid saved entry");
});

it("preserves legacy inputs without times and rejects invalid saved times", () => {
  const base = { decisions: [], nextCheckAt: 1, offset: 0, lastSentAt: null };
  const input = { type: "input", event: { id: "u1", kind: "user", text: "안녕" } };
  expect(restore("harin", "harin", { ...base, entries: [input] }).entries).toStrictEqual([input]);
  for (const at of ["bad", null, Number.POSITIVE_INFINITY])
    expect(() => restore("harin", "harin", { ...base, entries: [{ ...input, at }] })).toThrow(
      "Invalid saved input time",
    );
});

it("persists paused sessions, loads old records as active, and deletes only the requested file", async () => {
  const store = createStore(dir);
  const character = begin(personas["harin"]!, "pause-me", 100);
  character.paused = true;
  await store.save("harin", character);
  expect((await createStore(dir).load("pause-me"))?.character.paused).toBe(true);
  expect(await store.list()).toEqual([
    { id: "pause-me", persona: "harin", events: 0, paused: true },
  ]);
  const legacy = {
    persona: "harin",
    entries: [],
    decisions: [],
    nextCheckAt: 1,
    offset: 0,
    lastSentAt: null,
  };
  await writeFile(join(dir, "legacy.json"), JSON.stringify(legacy));
  expect((await store.load("legacy"))?.character.paused).toBe(false);
  expect((await store.list()).find((info) => info.id === "legacy")?.paused).toBe(false);
  for (const paused of [null, "yes", 0])
    expect(() => restore("harin", "legacy", { ...legacy, paused })).toThrow(
      "Invalid saved Character",
    );
  await writeFile(join(dir, "invalid.json"), JSON.stringify({ ...legacy, paused: "yes" }));
  await store.remove("pause-me");
  expect(await store.load("pause-me")).toBeUndefined();
  expect((await store.list()).map((info) => info.id)).toEqual(["legacy"]);
  await expect(store.remove("pause-me")).rejects.toMatchObject({ code: "ENOENT" });
  await expect(store.remove("../legacy")).rejects.toThrow("Invalid session id");
});
