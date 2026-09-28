import { expect, it } from "vitest";
import { createLab } from "./lab.ts";
import type { Character } from "./loop.ts";
import type { Saved, SessionInfo } from "./store.ts";
import type { Judge } from "./judge.ts";
import type { Model } from "@ren-ai/persona-engine";

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: lab HTTP JSON
const isCharacter = (value: unknown): value is Character =>
  typeof value === "object" && value !== null && "session" in value;
const model: Model = async () => Promise.reject(new Error("Model unused in this test"));
const judge: Judge = async () => Promise.reject(new Error("Judge unavailable"));
const share: Judge = async () => ({
  action: "initiate",
  probabilities: {},
  shifts: {},
  meaningfulAbsence: false,
  unitEnded: true,
  stage: "acquaintance",
});
const request = (path: string, body?: object): Request =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    body: body === undefined ? null : JSON.stringify(body),
  });

const readCharacter = async (response: Response): Promise<Character> => {
  // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: lab HTTP JSON
  const value: unknown = await response.json();
  if (!isCharacter(value)) throw new Error("Expected Character");
  return value;
};
const observingModel =
  (observed: string[][], reply: string): Model =>
  async (session) => {
    observed.push(session.events.map((event) => event.text));
    return { reply, changes: [] };
  };

const memoryStore = () => {
  const saved = new Map<string, Saved>();
  return {
    saved,
    store: {
      load: async (id: string) => saved.get(id),
      save: async (persona: string, character: Character) => {
        saved.set(character.session.id, { persona, character });
      },
      list: async (): Promise<SessionInfo[]> =>
        [...saved].map(([id, entry]) => ({
          id,
          persona: entry.persona,
          events: entry.character.session.events.length,
          paused: entry.character.paused,
        })),
      remove: async (id: string) => {
        saved.delete(id);
      },
    },
  };
};
const eventLab = (witness: Model, store: ReturnType<typeof memoryStore>["store"]) =>
  createLab(
    "page",
    "css",
    witness,
    share,
    store,
    () => undefined,
    () => 1_000,
  );

it("serves session actions under /api while keeping page routes separate", async () => {
  const { store } = memoryStore();
  const instance = createLab(
    "page",
    "css",
    model,
    judge,
    store,
    () => undefined,
    () => 1_000,
  );
  const value = await readCharacter(await instance.handle(request("/api/new?persona=jiwoo")));
  const id = value.session.id;
  expect(
    (await instance.handle(new Request(`http://localhost/api/event?session=${id}`))).status,
  ).toBe(404);
  expect(
    await (
      await instance.handle(new Request("http://localhost/api/sessions?persona=jiwoo"))
    ).json(),
  ).toMatchObject([{ id, persona: "jiwoo" }]);
  expect(
    await (await instance.handle(new Request(`http://localhost/api/session?session=${id}`))).json(),
  ).toEqual(value);
  const input = await instance.handle(
    request(`/api/input?session=${id}`, { id: "u1", kind: "user", text: "안녕" }),
  );
  expect(await input.json()).toMatchObject({ session: { events: [{ text: "안녕" }] } });
  expect(
    await (await instance.handle(request(`/api/tick?session=${id}&minutes=5`))).json(),
  ).toMatchObject({ offset: 300_000 });
  // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: exported HTTP JSON
  const recording: unknown = await (
    await instance.handle(new Request(`http://localhost/api/export?session=${id}`))
  ).json();
  if (typeof recording !== "object" || recording === null) throw new Error("Invalid export");
  const copy = await readCharacter(
    await instance.handle(request(`/api/import?session=${id}`, recording)),
  );
  expect(copy.session.id).not.toBe(id);
  expect(await (await instance.handle(request(`/api/reset?session=${id}`))).json()).toMatchObject({
    session: { events: [] },
  });
  expect((await instance.handle(new Request("http://localhost/api/missing"))).status).toBe(404);
});

it("introduces a prepared event through the ordinary life-event path exactly once", async () => {
  const { store, saved } = memoryStore();
  const observed: string[][] = [];
  const witness = observingModel(observed, "오늘은 사진전 설치 때문에 정신이 없네요.");
  const instance = eventLab(witness, store);
  const value = await readCharacter(await instance.handle(request("/api/new?persona=harin")));
  const id = value.session.id;
  await instance.handle(
    request(`/api/input?session=${id}`, { id: "u1", kind: "user", text: "안녕하세요" }),
  );
  const entry = saved.get(id)!.character;
  entry.session.stage = "acquaintance";
  await instance.handle(request(`/api/tick?session=${id}&minutes=5`));
  const result = await readCharacter(
    await instance.handle(request(`/api/tick?session=${id}&minutes=1440`)),
  );
  expect(result.session.events.map((event) => event.kind)).toEqual([
    "user",
    "reply",
    "life",
    "reply",
  ]);
  expect(result.session.events[2]?.id).toBe("event:harin-exhibit");
  expect(observed[1]?.[2]).toContain("사진전 설치");
  const resumed = eventLab(witness, store);
  const after = await readCharacter(
    await resumed.handle(request(`/api/tick?session=${id}&minutes=5`)),
  );
  expect(after.session.events.filter((event) => event.id === "event:harin-exhibit")).toHaveLength(
    1,
  );
});

it("lets the lab start a prepared event immediately without repeating it", async () => {
  const { store, saved } = memoryStore();
  const observed: string[][] = [];
  const witness = observingModel(observed, "오늘 전시 준비를 해야 해요.");
  const instance = eventLab(witness, store);
  const value = await readCharacter(await instance.handle(request("/api/new?persona=harin")));
  const id = value.session.id;
  const result = await readCharacter(await instance.handle(request(`/api/event?session=${id}`)));
  expect(result.session.stage).toBe("stranger");
  expect(result.session.events.map((event) => event.kind)).toEqual(["life", "reply"]);
  expect(result.session.events[0]?.id).toBe("event:harin-exhibit");
  expect(result.entries[0]).toMatchObject({ type: "input", at: 1_000 });
  expect(observed[0]?.[0]).toContain("사진전 설치");
  const resumed = eventLab(witness, store);
  const repeated = await resumed.handle(request(`/api/event?session=${id}`));
  expect(repeated.status).toBe(409);
  expect(await repeated.json()).toEqual({ error: "발생시킬 이벤트가 없습니다." });
  expect(saved.get(id)?.character.session.events).toHaveLength(2);
  const future = await readCharacter(await resumed.handle(request("/api/new?persona=jiwoo")));
  await resumed.handle(request(`/api/tick?session=${future.session.id}&minutes=5`));
  const stepped = await readCharacter(
    await resumed.handle(request(`/api/event?session=${future.session.id}`)),
  );
  expect(
    stepped.entries.find((entry) => entry.type === "input" && entry.event.kind === "life"),
  ).toMatchObject({ at: 301_000 });
  const other = await readCharacter(await resumed.handle(request("/api/new?persona=jiwoo")));
  saved.get(other.session.id)!.character.session.stage = "ended";
  expect((await resumed.handle(request(`/api/event?session=${other.session.id}`))).status).toBe(
    409,
  );
});
