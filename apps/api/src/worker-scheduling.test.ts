import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DurableObjectState } from "@cloudflare/workers-types";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, expect, test, vi } from "vitest";
import { ApiApplication } from "../worker/entry.ts";
import { executionBindings } from "../test/execution-bindings.ts";

const state = vi.hoisted(() => ({ filename: "", fail: false, duringTick: async () => {} }));
vi.mock("@ren-ai/plugin-session-folder/ground-rules", () => ({ default: "rules" }));
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      protected ctx: DurableObjectState,
      protected env: typeof executionBindings,
    ) {}
  },
}));
vi.mock("@effect/sql-sqlite-do", async () => {
  const { SqliteClient } = await import("@effect/sql-sqlite-node");
  return { SqliteClient: { layer: () => SqliteClient.layer({ filename: state.filename }) } };
});
vi.mock("./execution-runtime.ts", () => ({
  createExecutionRuntime: async () => ({
    tick: async () => {
      await state.duringTick();
      if (state.fail) throw Object.assign(new Error("private-upstream"), { code: "EXECUTOR_DOWN" });
    },
    close: async () => {},
  }),
}));

afterEach(() => vi.restoreAllMocks());

test("HTTP wakes survive actor replacement, concurrent hints survive an alarm, and failed alarms back off", async () => {
  const root = await mkdtemp(join(tmpdir(), "alarm-lifecycle-"));
  state.filename = join(root, "state.sqlite");
  let alarm: number | null = Date.now() + 600_000;
  const storage = fromPartial<DurableObjectState>({
    storage: {
      getAlarm: async () => alarm,
      setAlarm: async (time: number | Date) => {
        alarm = time instanceof Date ? time.getTime() : time;
      },
    },
  });
  class FixtureApplication extends ApiApplication {
    constructor() {
      super(storage, { ...executionBindings, APPLICATION: fromPartial({}) });
    }
  }
  const open = () => new FixtureApplication();
  let app = open();
  const wake = () =>
    app.fetch(
      new Request("https://app/management/intake/wake", {
        method: "POST",
        headers: { authorization: "Bearer management-secret" },
      }),
    );
  const logs: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    logs.push(String(chunk));
    return true;
  });
  try {
    const before = Date.now();
    expect(
      (
        await app.fetch(
          new Request("https://app/management/intake/watch", {
            headers: { authorization: "Bearer management-secret" },
          }),
        )
      ).status,
    ).toBe(200);
    expect(alarm).toBeGreaterThanOrEqual(before + 300_000);
    expect(
      (
        await app.fetch(
          new Request("https://app/management/intake/wake", {
            headers: { authorization: "Bearer management-secret" },
          }),
        )
      ).status,
    ).toBe(405);
    state.fail = true;
    alarm = null;
    await app.alarm();
    expect(alarm).toBeGreaterThan(Date.now() + 29_000);
    state.fail = false;
    alarm = null;
    await app.alarm();
    expect((await wake()).status).toBe(202);
    expect(alarm).toBeLessThan(Date.now() + 1000);
    app = open();
    state.duringTick = async () => {
      expect((await wake()).status).toBe(202);
    };
    alarm = null;
    await app.alarm();
    expect(alarm).toBeLessThan(Date.now() + 1000);
    state.duringTick = async () => {};
    alarm = null;
    await app.alarm();
    expect(alarm).toBeGreaterThan(Date.now() + 290_000);
    await wake();
    state.fail = true;
    for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000]) {
      alarm = null;
      const started = Date.now();
      await app.alarm();
      expect(alarm).toBeGreaterThanOrEqual(started + delay);
      expect(alarm).toBeLessThan(Date.now() + delay + 1000);
    }
    expect(logs.join("")).toContain("EXECUTOR_DOWN");
    expect(logs.join("")).not.toContain("private-upstream");
    state.fail = false;
    alarm = null;
    await app.alarm();
    expect(alarm).toBeGreaterThan(Date.now() + 290_000);
  } finally {
    state.fail = false;
    state.duringTick = async () => {};
    await rm(root, { recursive: true, force: true });
  }
});
