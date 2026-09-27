import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLab } from "./lab.ts";
import type { TurnLog } from "./lab.ts";
import { createStore } from "./store.ts";
import type { SessionInfo } from "./store.ts";
import { begin } from "./loop.ts";
import type { Character } from "./loop.ts";
import type { Judge } from "./judge.ts";
import type { Model } from "@repo/persona-engine";
import { personas } from "./personas.ts";

let dir = "";
let time = 1_000;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lab-"));
  time = 1_000;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const clock = () => time;
const silent = () => undefined;
const model: Model = async () => ({ reply: "대답할게", changes: [] });
const failing: Model = async () => {
  throw new Error("Gemini offline");
};
const judge: Judge = async ({ pending }) => ({
  action: pending.length ? "send_now" : "wait_for_user",
  probabilities: {},
  shifts: {},
  meaningfulAbsence: false,
  unitEnded: false,
  stage: "stranger",
});
const post = (url: string, body?: object | string | number | null): Request =>
  new Request(`http://localhost${url}`, {
    method: "POST",
    body: body === undefined ? null : JSON.stringify(body),
  });
const get = (url: string): Request => new Request(`http://localhost${url}`);
// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: HTTP JSON returned by the lab in integration tests
const isCharacter = (value: unknown): value is Character =>
  typeof value === "object" && value !== null && "session" in value && "decisions" in value;
const read = async (response: Response): Promise<Character> => {
  // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: integration-test HTTP JSON
  const value: unknown = await response.json();
  if (!isCharacter(value)) throw new Error("Expected Character");
  return value;
};
const list = async (response: Response): Promise<SessionInfo[]> => {
  // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: integration-test HTTP JSON
  const value: unknown = await response.json();
  if (!Array.isArray(value)) throw new Error("Expected session list");
  return value.filter(
    (item): item is SessionInfo =>
      typeof item === "object" && item !== null && "id" in item && "persona" in item,
  );
};
const lab = () => createLab("page", "css", model, judge, createStore(dir), silent, clock);
const create = async (instance: ReturnType<typeof lab>, persona: string): Promise<Character> =>
  read(await instance.handle(post(`/new?persona=${persona}`)));
const flush = async (
  instance: ReturnType<typeof lab>,
  sessionId: string,
  minutes = 1,
): Promise<Character> => {
  time += minutes * 60_000;
  await instance.runDue();
  return read(await instance.handle(get(`/session?session=${sessionId}`)));
};
const failingStore = (): ReturnType<typeof createStore> => ({
  load: async () => Promise.reject(new Error("disk failure")),
  save: async () => Promise.reject(new Error("disk failure")),
  list: async () => Promise.reject(new Error("disk failure")),
});
const oddStore = (): ReturnType<typeof createStore> => ({
  load: async () => Promise.reject("disk outage"),
  save: async () => Promise.reject("disk outage"),
  list: async () => Promise.reject("disk outage"),
});

it("serves the page and stylesheet", async () => {
  const instance = createLab(
    "<h1>Lab</h1>",
    "body { color: green }",
    model,
    judge,
    createStore(dir),
    silent,
    clock,
  );
  const page = await instance.handle(get("/"));
  expect(await page.text()).toContain("Lab");
  expect(page.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  const css = await instance.handle(get("/base.css"));
  expect(await css.text()).toBe("body { color: green }");
  expect(css.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
  expect(await (await instance.handle(post("/base.css"))).text()).toBe("Not found");
});

it("creates, lists and selects independent sessions per persona", async () => {
  const instance = lab();
  const first = await create(instance, "harin");
  const second = await create(instance, "harin");
  const third = await create(instance, "jiwoo");
  expect(first.session.id).not.toBe(second.session.id);
  await instance.handle(
    post(`/input?session=${first.session.id}`, { id: "u1", kind: "user", text: "안녕" }),
  );
  const sent = await flush(instance, first.session.id);
  expect(sent.session.events).toHaveLength(2);
  const harin = await list(await instance.handle(get("/sessions?persona=harin")));
  expect(harin.map((info) => info.id).toSorted()).toEqual(
    [first.session.id, second.session.id].toSorted(),
  );
  expect(harin.every((info) => info.persona === "harin")).toBe(true);
  expect(await list(await instance.handle(get("/sessions")))).toHaveLength(3);
  expect(
    (await read(await instance.handle(get(`/session?session=${second.session.id}`)))).session
      .events,
  ).toEqual([]);
  expect(
    (await read(await instance.handle(get(`/session?session=${third.session.id}`)))).session.events,
  ).toEqual([]);
});

it("keeps a session across a restart and takes time steps", async () => {
  const instance = lab();
  const created = await create(instance, "harin");
  const queued = await read(
    await instance.handle(
      post(`/input?session=${created.session.id}`, { id: "u1", kind: "user", text: "안녕" }),
    ),
  );
  expect(queued.session.events).toHaveLength(1);
  expect(queued.entries[0]).toEqual({
    type: "input",
    event: { id: "u1", kind: "user", text: "안녕" },
    at: time,
  });
  const restarted = lab();
  expect(await read(await restarted.handle(get(`/session?session=${created.session.id}`)))).toEqual(
    queued,
  );
  await restarted.runDue();
  expect(
    (await read(await restarted.handle(get(`/session?session=${created.session.id}`)))).decisions,
  ).toHaveLength(0);
  const replied = await flush(restarted, created.session.id);
  expect(replied.session.events).toHaveLength(2);
  expect(replied.decisions).toHaveLength(1);
  expect(replied.decisions[0]).toMatchObject({ trigger: "input" });
  const stepped = await read(
    await restarted.handle(post(`/tick?session=${created.session.id}&minutes=6`)),
  );
  expect(stepped.offset).toBe(6 * 60_000);
  expect(stepped.decisions).toHaveLength(2);
  expect(stepped.decisions[1]).toMatchObject({ trigger: "tick", at: time + 6 * 60_000 });
  const early = await read(
    await restarted.handle(post(`/tick?session=${created.session.id}&minutes=1`)),
  );
  expect(early.offset).toBe(7 * 60_000);
  expect(early.decisions).toHaveLength(2);
});

it("ticks every due session and resets, exports and imports", async () => {
  const instance = lab();
  const a = await create(instance, "harin");
  const b = await create(instance, "jiwoo");
  time += 5 * 60_000;
  await instance.runDue();
  expect(
    (await read(await instance.handle(get(`/session?session=${a.session.id}`)))).decisions,
  ).toHaveLength(1);
  expect(
    (await read(await instance.handle(get(`/session?session=${b.session.id}`)))).decisions,
  ).toHaveLength(1);
  const firstStep = await read(
    await instance.handle(post(`/tick?session=${a.session.id}&minutes=6`)),
  );
  expect(firstStep.offset).toBe(6 * 60_000);
  const admitted = await read(
    await instance.handle(
      post(`/input?session=${a.session.id}`, { id: "u1", kind: "user", text: "안녕" }),
    ),
  );
  expect(admitted.session.events).toHaveLength(1);
  expect(admitted.entries.at(-1)).toMatchObject({ type: "input", at: time + 6 * 60_000 });
  expect(admitted.nextCheckAt).toBe(time + 6 * 60_000 + 60_000);
  const sent = await flush(instance, a.session.id);
  expect(sent.decisions.at(-1)?.at).toBe(time + 6 * 60_000);
  // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: exported HTTP JSON
  const recording: unknown = await (
    await instance.handle(get(`/export?session=${a.session.id}`))
  ).json();
  if (typeof recording !== "object" || recording === null) throw new Error("Invalid export");
  const reset = await instance.handle(post(`/reset?session=${a.session.id}`));
  expect(reset.status).toBe(200);
  expect(await read(reset)).toMatchObject({
    session: { id: a.session.id },
  });
  expect(
    (await read(await instance.handle(get(`/session?session=${a.session.id}`)))).session.events,
  ).toEqual([]);
  const imported = await read(
    await instance.handle(post(`/import?session=${a.session.id}`, recording)),
  );
  expect(imported.session.id).not.toBe(a.session.id);
  expect(imported.session.events).toEqual(sent.session.events);
  expect(
    (await list(await instance.handle(get("/sessions?persona=harin")))).map((info) => info.id),
  ).toContain(imported.session.id);
});

it("retains a loaded snapshot even if the file breaks later", async () => {
  const store = createStore(dir);
  await store.save("harin", begin(personas["harin"]!, "session-a", time));
  const instance = createLab("page", "css", model, judge, store, silent, clock);
  const loaded = await read(await instance.handle(get("/session?session=session-a")));
  const background = createLab("page", "css", model, judge, createStore(dir), silent, clock);
  await background.runDue();
  await writeFile(join(dir, "session-a.json"), "broken");
  expect(await read(await instance.handle(get("/session?session=session-a")))).toEqual(loaded);
  expect((await read(await background.handle(get("/session?session=session-a")))).session.id).toBe(
    "session-a",
  );
});

it("serializes concurrent inputs for one session", async () => {
  const instance = lab();
  const created = await create(instance, "harin");
  const responses = await Promise.all([
    instance.handle(
      post(`/input?session=${created.session.id}`, { id: "u1", kind: "user", text: "먼저" }),
    ),
    instance.handle(
      post(`/input?session=${created.session.id}`, { id: "u2", kind: "user", text: "다음" }),
    ),
  ]);
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  const result = await read(await instance.handle(get(`/session?session=${created.session.id}`)));
  expect(
    result.session.events.filter((event) => event.kind === "user").map((event) => event.id),
  ).toEqual(["u1", "u2"]);
});

it("rejects invalid requests, unknown sessions and malformed storage", async () => {
  const instance = lab();
  const created = await create(instance, "harin");
  expect((await instance.handle(get("/missing"))).status).toBe(404);
  const missingSession = await instance.handle(get("/session"));
  expect(missingSession.status).toBe(404);
  expect(await missingSession.json()).toEqual({ error: "Missing session" });
  for (const route of ["/session?session=nope", "/export?session=nope"]) {
    const response = await instance.handle(get(route));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Unknown session" });
  }
  const badId = await instance.handle(get("/session?session=bad!"));
  expect(badId.status).toBe(400);
  expect(await badId.json()).toEqual({ error: "Invalid session id" });
  expect(await (await instance.handle(get("/session?session=..%2Fetc"))).json()).toEqual({
    error: "Invalid session id",
  });
  const unknownPersona = await instance.handle(post("/new?persona=nope"));
  expect(unknownPersona.status).toBe(404);
  expect(await unknownPersona.json()).toEqual({ error: "Unknown Persona" });
  for (const route of ["/new", "/input", "/tick", "/reset", "/import"])
    expect(await (await instance.handle(get(route))).text()).toBe("Not found");
  for (const route of ["/", "/session", "/export", "/sessions", "/missing"])
    expect(await (await instance.handle(post(route))).text()).toBe("Not found");
  const missingPersona = await instance.handle(post("/new"));
  expect(missingPersona.status).toBe(404);
  expect(await missingPersona.json()).toEqual({ error: "Missing Persona" });
  for (const route of ["/input", "/tick", "/reset", "/import"]) {
    const response = await instance.handle(post(route));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Missing session" });
  }
  for (const body of [
    null,
    3,
    "invalid",
    {},
    { id: 2, kind: "user", text: "hi" },
    { id: "u", kind: "reply", text: "hi" },
    { id: "u", kind: "user", text: 2 },
  ]) {
    const response = await instance.handle(post(`/input?session=${created.session.id}`, body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid input" });
  }
  expect(
    (
      await read(
        await instance.handle(
          post(`/input?session=${created.session.id}`, { id: "l1", kind: "life", text: "산책" }),
        ),
      )
    ).session.events[0]?.kind,
  ).toBe("life");
  for (const minutes of ["0", "1.5", "1441", "nan"]) {
    const response = await instance.handle(
      post(`/tick?session=${created.session.id}&minutes=${minutes}`),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid time step" });
  }
  expect(
    (await instance.handle(post(`/tick?session=${created.session.id}&minutes=1440`))).status,
  ).toBe(200);
  for (const [body, error] of [
    [null, "Invalid recording"],
    [{}, "Invalid recording"],
    [{ persona: 5 }, "Invalid recording"],
    [3, "Invalid recording"],
    ["text", "Invalid recording"],
    [{ persona: "nope" }, "Unknown Persona"],
  ] as const) {
    const response = await instance.handle(post(`/import?session=${created.session.id}`, body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
  }
  const unexpected = post(`/input?session=${created.session.id}`);
  Object.defineProperty(unexpected, "json", { value: async () => Promise.reject("bad body") });
  const unexpectedResponse = await instance.handle(unexpected);
  expect(unexpectedResponse.status).toBe(400);
  expect(await unexpectedResponse.json()).toEqual({ error: "Invalid request" });
});

it("skips corrupt or unrelated files when listing", async () => {
  const instance = lab();
  const created = await create(instance, "harin");
  await writeFile(join(dir, "broken.json"), "not json");
  await writeFile(join(dir, "ignore.txt"), "x");
  await writeFile(join(dir, "valid.txt"), JSON.stringify({ persona: "harin", entries: [] }));
  await writeFile(join(dir, "orphan.json"), JSON.stringify({ persona: "ghost", entries: [] }));
  await writeFile(join(dir, "listless.json"), JSON.stringify({ persona: "harin" }));
  await writeFile(join(dir, "noname.json"), JSON.stringify({ persona: 5, entries: [] }));
  await writeFile(
    join(dir, "strentries.json"),
    JSON.stringify({ persona: "harin", entries: "abc" }),
  );
  const response = await instance.handle(get("/sessions"));
  const sessions = await list(response);
  expect(sessions.map((info) => info.id)).toEqual([created.session.id]);
  // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: integration-test HTTP JSON
  const raw: unknown = await (await instance.handle(get("/sessions"))).json();
  expect(raw).toEqual([{ id: created.session.id, persona: "harin", events: 0 }]);
});

it("reports storage failures without crashing", async () => {
  for (const [store, error] of [
    [failingStore(), "disk failure"],
    [oddStore(), "Invalid request"],
  ] as const) {
    const instance = createLab("page", "css", model, judge, store, silent, clock);
    const created = await instance.handle(post("/new?persona=harin"));
    expect(created.status).toBe(400);
    expect(await created.json()).toEqual({ error });
    const session = await instance.handle(get("/session?session=x"));
    expect(session.status).toBe(400);
    expect(await session.json()).toEqual({ error });
    const sessions = await instance.handle(get("/sessions"));
    expect(sessions.status).toBe(400);
    expect(await sessions.json()).toEqual({ error });
  }
  await expect(
    createLab("page", "css", model, judge, failingStore(), silent, clock).runDue(),
  ).rejects.toThrow("disk failure");
  await expect(
    createLab("page", "css", model, judge, oddStore(), silent, clock).runDue(),
  ).rejects.toBe("disk outage");
});

it("logs decisions without revealing user text", async () => {
  const logs: TurnLog[] = [];
  const instance = createLab(
    "page",
    "css",
    model,
    judge,
    createStore(dir),
    (event) => logs.push(event),
    clock,
  );
  const created = await create(instance, "harin");
  await instance.handle(
    post(`/input?session=${created.session.id}`, {
      id: "u1",
      kind: "user",
      text: "SECRET CONVERSATION",
    }),
  );
  await flush(instance, created.session.id);
  expect(logs[0]).toMatchObject({
    session: created.session.id,
    persona: "harin",
    trigger: "input",
    action: "send_now",
    durationMs: 0,
  });
  time += 5 * 60_000;
  await instance.runDue();
  expect(logs[1]).toMatchObject({ trigger: "tick", action: "wait_for_user" });
  expect(JSON.stringify(logs)).not.toContain("SECRET CONVERSATION");
  const broken = createLab(
    "page",
    "css",
    failing,
    judge,
    createStore(join(dir, "other")),
    (event) => logs.push(event),
    clock,
  );
  const other = await create(broken, "harin");
  await broken.handle(
    post(`/input?session=${other.session.id}`, { id: "u2", kind: "user", text: "PRIVATE" }),
  );
  await flush(broken, other.session.id);
  expect(logs.at(-1)).toMatchObject({ action: "send_now", error: "Gemini offline" });
});

it("defaults the persona and time step when omitted", async () => {
  const instance = lab();
  const missing = await instance.handle(post("/new"));
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: "Missing Persona" });
  const created = await create(instance, "harin");
  const stepped = await read(await instance.handle(post(`/tick?session=${created.session.id}`)));
  expect(stepped.offset).toBe(5 * 60_000);
  expect(stepped.decisions).toHaveLength(1);
  expect(stepped.decisions[0]).toMatchObject({ trigger: "tick", at: time + 5 * 60_000 });
});

it("reads the virtual offset when deciding a periodic check", async () => {
  const instance = lab();
  const created = await create(instance, "harin");
  const stepped = await read(
    await instance.handle(post(`/tick?session=${created.session.id}&minutes=6`)),
  );
  expect(stepped.offset).toBe(6 * 60_000);
  const before = stepped.decisions.length;
  time += 350_000;
  await instance.runDue();
  const after = await read(await instance.handle(get(`/session?session=${created.session.id}`)));
  expect(after.decisions.length).toBe(before + 1);
  expect(after.decisions.at(-1)?.trigger).toBe("tick");
});

it("ignores a listed session that vanishes before it loads", async () => {
  const phantom: ReturnType<typeof createStore> = {
    load: async () => undefined,
    save: async () => undefined,
    list: async () => [{ id: "ghost", persona: "harin", events: 0 }],
  };
  const instance = createLab("page", "css", model, judge, phantom, silent, clock);
  await expect(instance.runDue()).resolves.toBeUndefined();
});

it("preserves both Personas' hidden starting traits", () => {
  expect(personas["harin"]?.hidden[0]).toMatchObject({
    id: "help",
    name: "도움 요청 회피",
    strength: 80,
  });
  expect(personas["jiwoo"]?.hidden[0]).toMatchObject({
    id: "disappoint",
    name: "실망시키기 두려움",
    strength: 75,
  });
});
