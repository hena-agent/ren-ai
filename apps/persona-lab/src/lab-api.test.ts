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
const request = (path: string, body?: object): Request =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    body: body === undefined ? null : JSON.stringify(body),
  });

it("serves session actions under /api while keeping page routes separate", async () => {
  const saved = new Map<string, Saved>();
  const store = {
    load: async (id: string) => saved.get(id),
    save: async (persona: string, character: Character) => {
      saved.set(character.session.id, { persona, character });
    },
    list: async (): Promise<SessionInfo[]> =>
      [...saved].map(([id, entry]) => ({
        id,
        persona: entry.persona,
        events: entry.character.session.events.length,
      })),
  };
  const instance = createLab(
    "page",
    "css",
    model,
    judge,
    store,
    () => undefined,
    () => 1_000,
  );
  const created = await instance.handle(request("/api/new?persona=jiwoo"));
  // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: lab HTTP JSON
  const value: unknown = await created.json();
  if (!isCharacter(value)) throw new Error("Expected Character");
  const id = value.session.id;
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
  const imported = await instance.handle(request(`/api/import?session=${id}`, recording));
  // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: imported HTTP JSON
  const copy: unknown = await imported.json();
  if (!isCharacter(copy)) throw new Error("Expected imported Character");
  expect(copy.session.id).not.toBe(id);
  expect(await (await instance.handle(request(`/api/reset?session=${id}`))).json()).toMatchObject({
    session: { events: [] },
  });
  expect((await instance.handle(new Request("http://localhost/api/missing"))).status).toBe(404);
});
