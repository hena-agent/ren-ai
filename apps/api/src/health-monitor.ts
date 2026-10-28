import { Clock, Effect, Option, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { parseHealth } from "@ren-ai/transport/health";
import { cloudflareConfiguration } from "./cloudflare-config.ts";
import type { CloudflareBindings, CloudflareConfiguration } from "./cloudflare-config.ts";
import { contactCause, contactLog, contactOperationId } from "./discovery/diagnostics.ts";
import { probeMessaging } from "./messaging-health.ts";

const messagingInterval = 120_000;
const messagingRetry = 20_000;
const executorInterval = 300_000;

const Facts = Schema.Struct({
  diskNearlyFull: Schema.Boolean,
  screenLocked: Schema.NullOr(Schema.Boolean),
});
const MonitorState = Schema.fromJsonString(
  Schema.Struct({
    messagingFailures: Schema.Number,
    messagingDue: Schema.Number,
    executorDue: Schema.Number,
    reported: Schema.Record(Schema.String, Schema.Boolean),
  }),
);
const initialState: typeof MonitorState.Type = {
  messagingFailures: 0,
  messagingDue: 0,
  executorDue: 0,
  reported: {},
};

const messagingResult = (
  state: typeof MonitorState.Type,
  available: boolean | undefined,
  now: number,
) => {
  const alerts: Record<string, boolean> = {};
  if (available === undefined)
    return { failures: state.messagingFailures, due: state.messagingDue, alerts };
  const failures = available ? 0 : Math.min(2, state.messagingFailures + 1);
  if (available || failures === 2) alerts["messaging-unavailable"] = !available;
  return { failures, due: now + (available ? messagingInterval : messagingRetry), alerts };
};

export interface MonitorStorage {
  readonly get: (key: "state") => Promise<string | undefined>;
  readonly put: (key: "state", value: string) => Promise<void>;
  readonly getAlarm: () => Promise<number | null>;
  readonly setAlarm: (time: number) => Promise<void>;
}
export type AlertChange = { readonly name: string; readonly raised: boolean };

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrow probe and report failures into payload-free diagnostics
const diagnose = (cause: unknown, stage: string, durationMs: number) => {
  const root = cause instanceof Error && cause.cause instanceof Error ? cause.cause : cause;
  const operationId = contactOperationId(cause);
  contactLog({
    requestId: randomUUID(),
    operation: "api-app.health",
    stage,
    outcome: "failed",
    durationMs,
    level: "error",
    ...contactCause(root),
    ...(operationId && { operationId }),
    ...(root instanceof Error &&
      "status" in root &&
      typeof root.status === "number" && { status: root.status }),
  });
};

const recover =
  <A>(stage: string, started: number, value: A) =>
  (cause: Error) =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      diagnose(cause, stage, now - started);
      return value;
    });

const executorAlerts = (
  execution: CloudflareConfiguration["execution"],
  fetcher: typeof fetch,
  started: number,
) =>
  Effect.tryPromise(async (signal) => {
    const response = await fetcher(new URL("/health", execution.apiMsgUrl), {
      headers: { Authorization: `Bearer ${execution.managementToken}` },
      signal,
      redirect: "manual",
    });
    if (response.status !== 200 && response.status !== 503)
      throw Object.assign(new Error("Executor health is unavailable"), {
        status: response.status,
        code: "EXECUTOR_HEALTH_HTTP",
      });
    try {
      const body = await response.json();
      const health = parseHealth(body, "api-msg");
      if (response.status !== (health.status === "ready" ? 200 : 503))
        throw new Error("Executor health status is inconsistent");
      return Schema.decodeUnknownSync(Facts)(body);
    } catch (cause) {
      throw Object.assign(new Error("Invalid executor health response", { cause }), {
        status: response.status,
        code: "EXECUTOR_HEALTH_INVALID",
      });
    }
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.map((facts): Record<string, boolean> => ({
      "disk-nearly-full": facts.diskNearlyFull,
      ...(facts.screenLocked !== null && { "screen-locked": facts.screenLocked }),
      "executor-unavailable": false,
    })),
    Effect.catch(recover("executor.health", started, { "executor-unavailable": true })),
  );

/** Probes the Mac on its own schedule and reports only changed alerts, so the application can sleep. */
const healthMonitor = (options: {
  readonly storage: MonitorStorage;
  readonly execution: CloudflareConfiguration["execution"];
  readonly fetcher: typeof fetch;
  readonly messaging: Effect.Effect<void, Error>;
  readonly report: (changes: readonly AlertChange[]) => Promise<void>;
}) => {
  const { storage } = options;
  const check = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    // Re-arm before probing so an interrupted check cannot end the schedule.
    yield* Effect.promise(() => storage.setAlarm(now + messagingInterval));
    const state = Option.getOrElse(
      Schema.decodeUnknownOption(MonitorState)(yield* Effect.promise(() => storage.get("state"))),
      () => initialState,
    );
    const executorDue = now >= state.executorDue;
    const messagingDue = now >= state.messagingDue;
    const [available, executor] = yield* Effect.all(
      [
        messagingDue
          ? options.messaging.pipe(
              Effect.timeout("5 seconds"),
              Effect.as(true),
              Effect.catch(recover("messaging.probe", now, false)),
            )
          : Effect.succeed(undefined),
        executorDue ? executorAlerts(options.execution, options.fetcher, now) : Effect.succeed({}),
      ],
      { concurrency: "unbounded" },
    );
    const messaging = messagingResult(state, available, now);
    const desired: Record<string, boolean> = {
      ...executor,
      ...messaging.alerts,
    };
    const changes = Object.entries(desired)
      .filter(([name, raised]) => state.reported[name] !== raised)
      .map(([name, raised]) => ({ name, raised }));
    const reported =
      changes.length === 0 ||
      (yield* Effect.tryPromise(() => options.report(changes)).pipe(
        Effect.timeout("10 seconds"),
        Effect.as(true),
        Effect.catch(recover("alert.report", now, false)),
      ));
    const next = {
      messagingFailures: messaging.failures,
      messagingDue: messaging.due,
      executorDue: executorDue ? now + executorInterval : state.executorDue,
      reported: reported ? { ...state.reported, ...desired } : state.reported,
    };
    yield* Effect.promise(() => storage.put("state", Schema.encodeSync(MonitorState)(next)));
    yield* Effect.promise(() => storage.setAlarm(Math.min(next.messagingDue, next.executorDue)));
  });
  const ensure = Effect.gen(function* () {
    if ((yield* Effect.promise(() => storage.getAlarm())) !== null) return;
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.promise(() => storage.setAlarm(now));
  });
  return { check, ensure };
};

/** The health monitor Durable Object: a thin binding of storage and the application to the monitor. */
export const monitorObject = (
  storage: MonitorStorage,
  bindings: CloudflareBindings,
  application: () => { fetch: (request: Request) => Promise<Response> },
  fetcher: typeof fetch = fetch,
) => {
  const configuration = cloudflareConfiguration(bindings, fetcher);
  const token = configuration.execution.managementToken;
  const active = !configuration.bootstrapOnly && token !== "";
  const monitor = healthMonitor({
    storage,
    execution: configuration.execution,
    fetcher,
    messaging: probeMessaging(configuration.execution, fetcher),
    report: async (changes) => {
      const response = await application().fetch(
        new Request("https://app/management/alerts", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ alerts: changes }),
        }),
      );
      await response.body?.cancel();
      if (response.status !== 204)
        throw Object.assign(new Error("Alert report was rejected"), {
          status: response.status,
          code: "ALERT_REPORT_REJECTED",
        });
    },
  });
  return {
    ensure: Effect.gen(function* () {
      if (active) yield* monitor.ensure;
      return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    }),
    alarm: Effect.gen(function* () {
      if (!active) return;
      const started = performance.now();
      yield* monitor.check;
      contactLog({
        requestId: randomUUID(),
        operation: "api-app.health",
        stage: "monitor",
        outcome: "completed",
        durationMs: performance.now() - started,
        level: "info",
      });
    }),
  };
};
