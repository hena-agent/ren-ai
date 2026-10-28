import { Deferred, Effect, Exit, Schema } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, expect, test, vi } from "vitest";
import { monitorObject } from "./health-monitor.ts";
import type { MonitorStorage } from "./health-monitor.ts";
import { executionBindings } from "../test/execution-bindings.ts";
import { captureGatewayLogs, gatewayFixture } from "../../imsg/test/gateway.test-helper.ts";

const bindings = { ...executionBindings, TOKEN_MANAGEMENT: "secret" };
const Report = Schema.fromJsonString(
  Schema.Struct({
    alerts: Schema.Array(Schema.Struct({ name: Schema.String, raised: Schema.Boolean })),
  }),
);
const facts = (diskNearlyFull: boolean, screenLocked: boolean | null, status = 200) =>
  Response.json(
    {
      service: "api-msg",
      revision: "development",
      status: status === 200 ? "ready" : "degraded",
      diskNearlyFull,
      screenLocked,
    },
    { status },
  );

const memory = () => {
  const state = { values: new Map<string, string>(), alarm: null as number | null };
  const storage: MonitorStorage = {
    get: async (key) => state.values.get(key),
    put: async (key, value) => {
      state.values.set(key, value);
    },
    getAlarm: async () => state.alarm,
    setAlarm: async (time) => {
      state.alarm = time;
    },
  };
  return { state, storage };
};

/** The Mac: api-msg's health and the imsg gateway behind it. */
const mac = (health: (init?: RequestInit) => Promise<Response>) => {
  const gateway = gatewayFixture();
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    return new URL(request.url).pathname === "/health"
      ? health(init)
      : gateway.transport.fetch(new Request(new URL("/rpc", request.url), request));
  });
  return { gateway, fetcher };
};

/** The application's alert endpoint, recording each report it receives. */
const application = (
  respond: () => Promise<Response> = async () => new Response(null, { status: 204 }),
) => {
  const reports: (typeof Report.Type)["alerts"][] = [];
  const requests: Request[] = [];
  return {
    reports,
    requests,
    object: () => ({
      fetch: async (request: Request) => {
        requests.push(request);
        const response = await respond();
        if (response.status === 204)
          reports.push(Schema.decodeUnknownSync(Report)(await request.text()).alerts);
        return response;
      },
    }),
  };
};

const logs = { stdout: [] as string[], stderr: [] as string[] };
const capture = () => {
  for (const stream of ["stdout", "stderr"] as const)
    vi.spyOn(process[stream], "write").mockImplementation((chunk) => {
      logs[stream].push(String(chunk));
      return true;
    });
};
afterEach(() => {
  vi.restoreAllMocks();
  logs.stdout = [];
  logs.stderr = [];
});

test("executor checks run every five minutes, report only changes and keep facts apart from credentials", async () => {
  capture();
  let degraded = true;
  const { gateway, fetcher } = mac(async () =>
    degraded ? facts(true, true, 503) : facts(false, null),
  );
  const app = application();
  const { state, storage } = memory();
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const first = monitorObject(storage, bindings, app.object, fetcher);
        yield* first.alarm;
        yield* first.alarm;
        expect(app.reports).toEqual([
          [
            { name: "disk-nearly-full", raised: true },
            { name: "screen-locked", raised: true },
            { name: "executor-unavailable", raised: false },
            { name: "messaging-unavailable", raised: false },
          ],
        ]);
        expect(state.alarm).toBe(120_000);
        degraded = false;
        yield* TestClock.adjust("5 minutes");
        // A replacement actor continues the persisted schedule and reported states.
        yield* monitorObject(storage, bindings, app.object, fetcher).alarm;
        expect(app.reports.at(-1)).toEqual([{ name: "disk-nearly-full", raised: false }]);
        expect(state.alarm).toBe(300_000 + 120_000);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    const checks = fetcher.mock.calls.filter(([input]) =>
      new Request(input).url.endsWith("/health"),
    );
    expect(checks).toHaveLength(2);
    expect(new Headers(checks[0]![1]?.headers).get("authorization")).toBe("Bearer secret");
    expect(app.requests[0]!.headers.get("authorization")).toBe("Bearer secret");
    expect(logs.stdout.join("")).toContain('"stage":"monitor"');
  } finally {
    await gateway.server.dispose();
  }
});

test("independent persisted deadlines preserve the two-minute and five-minute cadence", async () => {
  capture();
  const { gateway, fetcher } = mac(async () => facts(false, false));
  const app = application();
  const { state, storage } = memory();
  const messaging: number[] = [];
  let minute = 0;
  gateway.gestures.gestures.probe = () =>
    Effect.sync(() => {
      messaging.push(minute);
    });
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        for (const due of [0, 2, 4, 5, 6, 8, 10]) {
          yield* TestClock.adjust((due - minute) * 60_000);
          minute = due;
          yield* monitorObject(storage, bindings, app.object, fetcher).alarm;
        }
        expect(messaging).toEqual([0, 2, 4, 6, 8, 10]);
        expect(
          fetcher.mock.calls.filter(([input]) => new Request(input).url.endsWith("/health")),
        ).toHaveLength(3);
        expect(app.reports).toHaveLength(1);
        expect(state.alarm).toBe(12 * 60_000);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  } finally {
    await gateway.server.dispose();
  }
});

test.each([502, 503, 200])(
  "executor HTTP %s records a safe diagnostic and raises the unavailable alert",
  async (status) => {
    capture();
    const { gateway, fetcher } = mac(async () =>
      status === 200
        ? Response.json({ service: "api-msg", revision: "development", status: "degraded" })
        : new Response(null, { status }),
    );
    const app = application();
    try {
      await Effect.runPromise(
        monitorObject(memory().storage, bindings, app.object, fetcher).alarm.pipe(
          Effect.provide(TestClock.layer()),
        ),
      );
      expect(app.reports[0]).toContainEqual({ name: "executor-unavailable", raised: true });
      const diagnostics = logs.stderr.join("");
      expect(diagnostics).toContain("executor.health");
      expect(diagnostics).toContain(`"status":${status}`);
      expect(diagnostics).not.toContain("secret");
    } finally {
      await gateway.server.dispose();
    }
  },
);

test("stalled probes and reports time out without ending the schedule", async () => {
  capture();
  const entered = Deferred.makeUnsafe<void>();
  const signals: AbortSignal[] = [];
  const { gateway, fetcher } = mac(
    (init) =>
      new Promise<Response>((_resolve, reject) => {
        signals.push(init!.signal!);
        Effect.runSync(Deferred.succeed(entered, undefined));
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), {
          once: true,
        });
      }),
  );
  gateway.gestures.gestures.probe = () => Effect.never;
  const app = application(() => new Promise(() => {}));
  const { state, storage } = memory();
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const check = yield* monitorObject(storage, bindings, app.object, fetcher).alarm.pipe(
          Effect.forkScoped,
        );
        yield* Deferred.await(entered);
        expect(state.alarm).toBe(120_000);
        yield* TestClock.adjust("10 seconds");
        yield* TestClock.adjust("10 seconds");
        const result = check.pollUnsafe();
        expect(result && Exit.isSuccess(result)).toBe(true);
        expect(signals.every((signal) => signal.aborted)).toBe(true);
        // Nothing was confirmed as reported, so the next check reports again.
        expect(state.values.get("state")).toContain('"reported":{}');
        // The failed Messages probe retries 20 seconds after the check began.
        expect(state.alarm).toBe(20_000);
      }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
    );
    const diagnostics = logs.stderr.join("");
    for (const stage of ["executor.health", "messaging.probe", "alert.report", "TimeoutError"])
      expect(diagnostics).toContain(stage);
  } finally {
    await gateway.server.dispose();
  }
});

test("Messages failures survive replacement, alert after two probes, retry quickly and clear on recovery", async () => {
  capture();
  const macLogs = captureGatewayLogs();
  const { gateway, fetcher } = mac(async () => facts(false, false));
  let failing = true;
  gateway.gestures.gestures.probe = () =>
    failing
      ? Effect.fail(Object.assign(new Error("private Apple detail"), { code: "APNS_UNAVAILABLE" }))
      : Effect.void;
  const app = application();
  const { state, storage } = memory();
  const messaging = () =>
    app.reports.flat().filter((change) => change.name === "messaging-unavailable");
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* monitorObject(storage, bindings, app.object, fetcher).alarm;
        expect(messaging()).toEqual([]);
        expect(state.alarm).toBe(20_000);
        yield* TestClock.adjust("20 seconds");
        const replacement = monitorObject(storage, bindings, app.object, fetcher);
        yield* replacement.alarm;
        expect(messaging()).toEqual([{ name: "messaging-unavailable", raised: true }]);
        yield* TestClock.adjust("20 seconds");
        yield* replacement.alarm;
        expect(messaging()).toHaveLength(1);
        failing = false;
        yield* TestClock.adjust("20 seconds");
        yield* replacement.alarm;
        expect(messaging().at(-1)).toEqual({ name: "messaging-unavailable", raised: false });
        expect(state.alarm).toBe(60_000 + 120_000);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    const diagnostics = logs.stderr.join("");
    expect(diagnostics).toContain("messaging.probe");
    expect(diagnostics).toContain('"operationId":');
    expect(macLogs.logs.join("")).toContain("APNS_UNAVAILABLE");
    expect(diagnostics).not.toMatch(/private Apple|secret/);
  } finally {
    macLogs.restore();
    await gateway.server.dispose();
  }
});

test("a rejected report is retried on the next check and ensure keeps an existing schedule", async () => {
  capture();
  const { gateway, fetcher } = mac(async () => facts(false, false));
  let status = 503;
  const app = application(async () => new Response(null, { status }));
  const { state, storage } = memory();
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const object = monitorObject(storage, bindings, app.object, fetcher);
        expect((yield* object.ensure).status).toBe(204);
        expect(state.alarm).toBe(0);
        yield* object.alarm;
        expect(app.reports).toEqual([]);
        yield* object.ensure;
        expect(state.alarm).toBe(120_000);
        status = 204;
        yield* TestClock.adjust("2 minutes");
        yield* object.alarm;
        expect(app.reports).toEqual([[{ name: "messaging-unavailable", raised: false }]]);
        yield* TestClock.adjust("2 minutes");
        yield* object.alarm;
        expect(app.requests).toHaveLength(2);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(logs.stderr.join("")).toContain("ALERT_REPORT_REJECTED");
  } finally {
    await gateway.server.dispose();
  }
});

test("the monitor stays idle until execution is configured", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const app = application();
  const { state, storage } = memory();
  for (const configuration of [
    { ...bindings, BOOTSTRAP_ONLY: "true" },
    { ...bindings, TOKEN_MANAGEMENT: " " },
  ]) {
    const object = monitorObject(storage, configuration, app.object, fetcher);
    expect((await Effect.runPromise(object.ensure)).status).toBe(204);
    await Effect.runPromise(object.alarm);
  }
  expect(state.alarm).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  expect(app.requests).toEqual([]);
});
