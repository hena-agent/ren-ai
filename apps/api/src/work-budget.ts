import { Cause, Clock, Context, Effect } from "effect";
import { SqlClient } from "effect/sql";
import { scheduleWork, safetyInterval } from "./scheduling.ts";
import { contactCause, contactLog } from "./discovery/diagnostics.ts";

interface Budget {
  readonly until: number;
  readonly requestId: string;
  remaining: number;
  deferred: boolean;
}
const CurrentBudget = Context.Reference<Budget | undefined>("ren-ai/AlarmBudget", {
  defaultValue: () => undefined,
});

export class DeferredWork extends Error {
  readonly code = "APPLICATION_WORK_DEFERRED";
  constructor() {
    super("Application work will resume on the next alarm");
  }
}

/** The failed lane already owns a durable retry; other lanes need no global backoff. */
export class WorkLaneFailure extends Error {
  readonly code = "APPLICATION_LANE_FAILED";
  constructor(cause: Error) {
    super(cause.message, { cause });
  }
}

/** Admission budget: never cancel a mutation merely because another item used its turn. */
export const claimWork = Effect.gen(function* () {
  const budget = yield* CurrentBudget;
  if (!budget) return true;
  const now = yield* Clock.currentTimeMillis;
  if (now < budget.until && budget.remaining-- > 0) return true;
  if (!budget.deferred) {
    budget.deferred = true;
    yield* scheduleWork("execution", now + 1_000);
  }
  return false;
});

export const workCheckpoint = claimWork.pipe(
  Effect.flatMap((admitted) => (admitted ? Effect.void : Effect.fail(new DeferredWork()))),
);
export const workBatchSize = Effect.map(CurrentBudget, (budget) => (budget ? 5 : 100));
export const workRequestId = Effect.map(
  CurrentBudget,
  (budget) => budget?.requestId ?? crypto.randomUUID(),
);

export const withWorkBudget = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  requestId: string = crypto.randomUUID(),
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    return yield* effect.pipe(
      Effect.provideService(CurrentBudget, {
        until: now + 45_000,
        remaining: 40,
        deferred: false,
        requestId,
      }),
    );
  });

export const maintenanceWork = <E, R>(name: string, effect: Effect.Effect<void, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = yield* Clock.currentTimeMillis;
    const [last] = yield* sql<{
      at: number;
    }>`SELECT at FROM application_clock WHERE name = ${name}`;
    if (last && last.at + safetyInterval > now) return;
    yield* effect;
    yield* sql`INSERT INTO application_clock (name, at) VALUES (${name}, ${now}) ON CONFLICT(name) DO UPDATE SET at = excluded.at`;
  });

/** Advance before I/O; a failed or interrupted lane cannot monopolize replacement actors. */
export const runWorkLanes = <E, R>(
  key: string,
  lanes: readonly { name: string; run: Effect.Effect<void, E, R> }[],
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [cursor] = yield* sql<{
      at: number;
    }>`SELECT at FROM application_clock WHERE name = ${key}`;
    let failure: WorkLaneFailure | undefined;
    let deferred = false;
    const requestId = yield* workRequestId;
    const retries = yield* sql<{
      name: string;
      due: number;
      attempts: number;
    }>`SELECT name, due, attempts FROM application_work
      WHERE name IN ${sql.in(lanes.map((lane) => `lane:${key}:${lane.name}`))}`;
    const retryByName = new Map(retries.map((row) => [row.name, row]));
    for (let offset = 0; offset < lanes.length; offset++) {
      const index = ((cursor?.at ?? 0) + offset) % lanes.length;
      const lane = lanes[index]!;
      const name = `lane:${key}:${lane.name}`;
      const retry = retryByName.get(name);
      if (retry && retry.due > (yield* Clock.currentTimeMillis)) continue;
      if (!(yield* claimWork)) break;
      yield* sql`INSERT INTO application_clock (name, at) VALUES (${key}, ${(index + 1) % lanes.length}) ON CONFLICT(name) DO UPDATE SET at = excluded.at`;
      const started = yield* Clock.currentTimeMillis;
      let completed = true;
      yield* lane.run.pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (Cause.hasInterrupts(cause)) return yield* Effect.failCause(cause);
            const error = Cause.squash(cause);
            if (error instanceof DeferredWork) {
              deferred = true;
              completed = false;
              return undefined;
            }
            if (error instanceof WorkLaneFailure) {
              failure ??= error;
              return undefined;
            }
            completed = false;
            failure ??= new WorkLaneFailure(
              error instanceof Error
                ? error
                : new Error("Application lane failed", { cause: error }),
            );
            const attempts = (retry?.attempts ?? 0) + 1;
            const now = yield* Clock.currentTimeMillis;
            const due = now + Math.min(30_000 * 2 ** Math.min(attempts - 1, 4), safetyInterval);
            yield* sql`INSERT INTO application_work(name, due, attempts) VALUES (${name}, ${due}, ${attempts})
              ON CONFLICT(name) DO UPDATE SET due = excluded.due, attempts = excluded.attempts, generation = generation + 1`;
            contactLog({
              requestId,
              operation: "api-app.work",
              stage: lane.name,
              outcome: "failed",
              level: "error",
              durationMs: (yield* Clock.currentTimeMillis) - started,
              ...contactCause(error),
            });
            return undefined;
          }),
        ),
      );
      if (completed && retry) yield* sql`DELETE FROM application_work WHERE name = ${name}`;
    }
    if (failure) return yield* Effect.fail(failure);
    if (deferred || (yield* CurrentBudget)?.deferred) return yield* Effect.fail(new DeferredWork());
    return undefined;
  });
