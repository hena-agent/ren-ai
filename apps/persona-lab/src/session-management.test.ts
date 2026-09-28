import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLab } from "./lab.ts";
import { createStore } from "./store.ts";
import type { Character } from "./loop.ts";
import type { Judge } from "./judge.ts";
import type { Model } from "@ren-ai/persona-engine";

const post = (path: string): Request => new Request(`http://localhost${path}`, { method: "POST" });
const get = (path: string): Request => new Request(`http://localhost${path}`);
// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: lab HTTP response
const isCharacter = (value: unknown): value is Character =>
  typeof value === "object" && value !== null && "session" in value;
const read = async (response: Response): Promise<Character> => {
  // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: lab HTTP response
  const value: unknown = await response.json();
  if (!isCharacter(value)) throw new Error("Expected session");
  return value;
};
const model: Model = async () => ({ reply: "네", changes: [] });
const judgeFor =
  (calls: string[]): Judge =>
  async ({ session }) => {
    calls.push(session.id);
    return {
      action: "wait_for_user",
      probabilities: {},
      shifts: {},
      meaningfulAbsence: false,
      unitEnded: false,
      stage: "stranger",
    };
  };
const lab = (dir: string, judge: Judge, clock: () => number) =>
  createLab("page", "css", model, judge, createStore(dir), () => undefined, clock);

it("pauses background checks but permits manual messages, time steps and events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lab-manage-"));
  try {
    let now = 1_000;
    const judged: string[] = [];
    const judge = judgeFor(judged);
    const instance = lab(dir, judge, () => now);
    const a = await read(await instance.handle(post("/new?persona=harin")));
    const b = await read(await instance.handle(post("/new?persona=jiwoo")));
    const paused = await read(await instance.handle(post(`/pause?session=${a.session.id}`)));
    expect(paused.paused).toBe(true);
    expect((await createStore(dir).list()).find((info) => info.id === a.session.id)?.paused).toBe(
      true,
    );
    const disk = createStore(dir);
    const loaded: string[] = [];
    const observer = createLab(
      "page",
      "css",
      model,
      judge,
      {
        ...disk,
        load: async (id: string) => {
          loaded.push(id);
          return disk.load(id);
        },
      },
      () => undefined,
      () => now,
    );
    await observer.runDue();
    expect(loaded).toEqual([b.session.id]);
    now += 300_000;
    await instance.runDue();
    expect(judged).toEqual([b.session.id]);
    const restarted = lab(dir, judge, () => now);
    expect(
      (await read(await restarted.handle(get(`/session?session=${a.session.id}`)))).paused,
    ).toBe(true);
    await restarted.handle(
      new Request(`http://localhost/input?session=${a.session.id}`, {
        method: "POST",
        body: JSON.stringify({ id: "u1", kind: "user", text: "안녕" }),
      }),
    );
    now += 60_000;
    await restarted.runDue();
    expect(judged).toEqual([b.session.id]);
    const manual = await read(
      await restarted.handle(post(`/tick?session=${a.session.id}&minutes=1`)),
    );
    expect(manual.paused).toBe(true);
    expect(judged.filter((id) => id === a.session.id)).toHaveLength(1);
    const event = await read(await restarted.handle(post(`/event?session=${a.session.id}`)));
    expect(event.paused).toBe(true);
    expect(event.session.events.some((entry) => entry.id === "event:harin-exhibit")).toBe(true);
    const resumed = await read(await restarted.handle(post(`/resume?session=${a.session.id}`)));
    expect(resumed.paused).toBe(false);
    expect(resumed.nextCheckAt).toBe(now + resumed.offset + 60_000);
    await restarted.runDue();
    expect(judged.filter((id) => id === a.session.id)).toHaveLength(2);
    now += 60_000;
    await restarted.runDue();
    expect(judged.filter((id) => id === a.session.id)).toHaveLength(3);
    await restarted.handle(post(`/pause?session=${a.session.id}`));
    const reset = await read(await restarted.handle(post(`/reset?session=${a.session.id}`)));
    expect(reset.paused).toBe(true);
    expect(reset.session.events).toEqual([]);
    const quiet = await read(await restarted.handle(post(`/resume?session=${a.session.id}`)));
    expect(quiet.nextCheckAt).toBe(now + quiet.offset + 300_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("deletes a cached session so it cannot be reloaded or checked again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lab-delete-"));
  try {
    let now = 1_000;
    const calls: string[] = [];
    const judge = judgeFor(calls);
    const instance = lab(dir, judge, () => now);
    const a = await read(await instance.handle(post("/new?persona=harin")));
    const b = await read(await instance.handle(post("/new?persona=jiwoo")));
    expect((await instance.handle(get("/personas/jiwoo"))).status).toBe(200);
    await instance.handle(get(`/session?session=${a.session.id}`));
    expect(
      (
        await instance.handle(
          new Request(`http://localhost/other?session=${a.session.id}`, { method: "DELETE" }),
        )
      ).status,
    ).toBe(404);
    // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: exported lab JSON
    const recording: unknown = await (
      await instance.handle(get(`/export?session=${a.session.id}`))
    ).json();
    const deleted = await instance.handle(
      new Request(`http://localhost/session?session=${a.session.id}`, { method: "DELETE" }),
    );
    expect(await deleted.json()).toEqual({ deleted: a.session.id });
    expect((await instance.handle(get(`/session?session=${a.session.id}`))).status).toBe(404);
    expect(
      (await lab(dir, judge, () => now).handle(post(`/pause?session=${a.session.id}`))).status,
    ).toBe(404);
    expect((await createStore(dir).list()).map((info) => info.id)).toEqual([b.session.id]);
    now += 300_000;
    await instance.runDue();
    expect(calls).toEqual([b.session.id]);
    const removedLast = await instance.handle(
      new Request(`http://localhost/session?session=${b.session.id}`, { method: "DELETE" }),
    );
    expect(removedLast.status).toBe(200);
    expect(await createStore(dir).list()).toEqual([]);
    const imported = await read(
      await instance.handle(
        new Request("http://localhost/import", { method: "POST", body: JSON.stringify(recording) }),
      ),
    );
    expect(imported.session.id).not.toBe(a.session.id);
    expect((await createStore(dir).list()).map((info) => info.id)).toEqual([imported.session.id]);
    const malformed = post("/import");
    Object.defineProperty(malformed, "json", { value: async () => Promise.reject("bad body") });
    expect(await (await instance.handle(malformed)).json()).toEqual({ error: "Invalid request" });
    const [removedImported] = await Promise.all([
      instance.handle(
        new Request(`http://localhost/session?session=${imported.session.id}`, {
          method: "DELETE",
        }),
      ),
      instance.runDue(),
    ]);
    expect(removedImported.status).toBe(200);
    expect(await createStore(dir).list()).toEqual([]);
    expect((await instance.handle(get(`/session?session=${imported.session.id}`))).status).toBe(
      404,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
