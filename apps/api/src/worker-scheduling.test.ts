import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DurableObjectState } from "@cloudflare/workers-types";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, expect, test, vi } from "vitest";
import { ApiApplication } from "../worker/entry.ts";
import { executionBindings } from "../test/execution-bindings.ts";
import { DeferredWork } from "./work-budget.ts";

const state = vi.hoisted(() => ({
  filename: "",
  fail: false,
  ticks: 0,
  duringTick: async () => {},
}));
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
  const sqlite = await import("@effect/sql-sqlite-node");
  return { SqliteClient: { layer: () => sqlite.SqliteClient.layer({ filename: state.filename }) } };
});
vi.mock("./execution-runtime.ts", () => ({
  createExecutionRuntime: async () => ({
    tick: async () => {
      state.ticks++;
      await state.duringTick();
      if (state.fail) throw Object.assign(new Error("private-upstream"), { code: "EXECUTOR_DOWN" });
    },
    close: async () => {},
  }),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const advance = (milliseconds: number) => vi.setSystemTime(Date.now() + milliseconds);

const nextReport = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [row] = yield* sql<{
        due: number;
      }>`SELECT due FROM application_work WHERE name = 'metrics-report'`;
      return row!.due;
    }).pipe(Effect.scoped, Effect.provide(SqliteClient.layer({ filename: state.filename }))),
  );

test("idle actors keep no wake, store work never starts execution, and execution backoff keeps its work", async () => {
  const root = await mkdtemp(join(tmpdir(), "alarm-lifecycle-"));
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ id: "accepted" }));
  state.filename = join(root, "state.sqlite");
  let alarm: number | null = Date.now() + 600_000;
  const storage = fromPartial<DurableObjectState>({
    storage: {
      getAlarm: async () => alarm,
      setAlarm: async (time: number | Date) => {
        alarm = time instanceof Date ? time.getTime() : time;
      },
      deleteAlarm: async () => {
        alarm = null;
      },
    },
  });
  const ensured: string[] = [];
  class FixtureApplication extends ApiApplication {
    constructor() {
      super(storage, {
        ...executionBindings,
        APPLICATION: fromPartial({}),
        ACTIVITY: {
          idFromName: () => fromPartial({}),
          get: () => ({ fetch: async () => Response.json([]) }),
        },
        MONITOR: {
          idFromName: () => fromPartial({}),
          get: () => ({
            fetch: async (request: Request) => {
              ensured.push(new URL(request.url).pathname);
              return new Response(null, { status: 204 });
            },
          }),
        },
      });
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
    // The persisted overdue daily Report is store work: it wakes the actor, never execution.
    expect(alarm).toBeLessThan(before + 1000);
    await app.alarm();
    expect(state.ticks).toBe(0);
    // No safety net: the next wake is exactly the next persisted deadline.
    expect(alarm).toBe(await nextReport());

    expect((await wake()).status).toBe(202);
    expect(alarm).toBeLessThan(Date.now() + 1000);
    state.fail = true;
    await app.alarm();
    expect(state.ticks).toBe(1);
    expect(alarm).toBe(Date.now() + 30_000);
    // A store wake during the backoff neither starts execution nor drops its pending work.
    state.fail = false;
    await app.alarm();
    expect(state.ticks).toBe(1);
    expect(alarm).toBe(Date.now() + 30_000);
    advance(30_000);
    await app.alarm();
    expect(state.ticks).toBe(2);
    expect(alarm).toBe(await nextReport());
    expect(
      (
        await app.fetch(
          new Request("https://app/management/intake/wake", {
            headers: { authorization: "Bearer management-secret" },
          }),
        )
      ).status,
    ).toBe(405);

    await wake();
    app = open();
    state.duringTick = async () => {
      expect((await wake()).status).toBe(202);
    };
    await app.alarm();
    expect(alarm).toBeLessThan(Date.now() + 1000);
    state.duringTick = async () => {};
    await app.alarm();
    expect(alarm).toBe(await nextReport());

    await wake();
    state.duringTick = async () => {
      throw new DeferredWork();
    };
    await app.alarm();
    expect(alarm).toBe(Date.now() + 1_000);
    state.duringTick = async () => {};
    advance(1_000);
    await app.alarm();
    expect(alarm).toBe(await nextReport());

    await wake();
    state.fail = true;
    for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000]) {
      await app.alarm();
      expect(alarm).toBe(Date.now() + delay);
      advance(delay);
    }
    expect(logs.join("")).toContain("EXECUTOR_DOWN");
    expect(logs.join("")).not.toContain("private-upstream");
    state.fail = false;
    await app.alarm();
    expect(alarm).toBe(await nextReport());
    // Each actor starts the health monitor once.
    expect(ensured).toEqual(["/ensure", "/ensure"]);
  } finally {
    state.fail = false;
    state.duringTick = async () => {};
    await rm(root, { recursive: true, force: true });
  }
});

test("a failing health monitor never fails the application's own request", async () => {
  const root = await mkdtemp(join(tmpdir(), "alarm-monitor-"));
  state.filename = join(root, "state.sqlite");
  const logs: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    logs.push(String(chunk));
    return true;
  });
  const storage = fromPartial<DurableObjectState>({
    storage: { getAlarm: async () => null, setAlarm: async () => {} },
  });
  const monitors = [
    {
      idFromName: () => {
        throw new Error("missing binding");
      },
    },
    {
      idFromName: () => fromPartial({}),
      get: () => ({ fetch: async () => new Response(null, { status: 500 }) }),
    },
  ];
  try {
    for (const monitor of monitors) {
      const app = new (class extends ApiApplication {
        constructor() {
          super(storage, {
            ...executionBindings,
            APPLICATION: fromPartial({}),
            ACTIVITY: fromPartial({}),
            MONITOR: fromPartial(monitor),
          });
        }
      })();
      const response = await app.fetch(
        new Request("https://app/management/intake/watch", {
          headers: { authorization: "Bearer management-secret" },
        }),
      );
      expect(response.status).toBe(200);
      await vi.waitFor(() => expect(logs.join("")).toContain("monitor.ensure"));
      logs.length = 0;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
