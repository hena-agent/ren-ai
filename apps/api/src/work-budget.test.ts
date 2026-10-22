import { Cause, Clock, Deferred, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { runMessagingTest } from "../test/messaging.test-helper.ts";
import { captureDiagnostics } from "../test/diagnostics.test-helper.ts";
import { migrate } from "./database.ts";
import { intakeQueue } from "./intake/queue.ts";
import {
  finishApplicationWork,
  nextApplicationWake,
  scheduleWork,
  scheduledApplicationWork,
} from "./scheduling.ts";
import { exhaustedAlarm } from "../test/work-budget.test-helper.ts";
import {
  claimWork,
  DeferredWork,
  maintenanceWork,
  runWorkLanes,
  withWorkBudget,
  workBatchSize,
  workCheckpoint,
  WorkLaneFailure,
} from "./work-budget.ts";

test("alarm admission limits are scoped and persist one deferred wake without cancelling started work", async () => {
  await runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const sql = yield* SqlClient.SqlClient;
      expect(yield* claimWork).toBe(true);
      yield* runWorkLanes("unbudgeted", [{ name: "idle", run: Effect.void }]);
      expect(yield* workBatchSize).toBe(100);
      yield* workCheckpoint;
      const results = yield* withWorkBudget(
        Effect.gen(function* () {
          expect(yield* workBatchSize).toBe(5);
          const admitted = yield* Effect.forEach(Array.from({ length: 42 }), () => claimWork);
          expect(yield* workCheckpoint.pipe(Effect.flip)).toBeInstanceOf(DeferredWork);
          return admitted;
        }),
      );
      expect(results.filter(Boolean)).toHaveLength(40);
      expect(yield* sql`SELECT name, generation FROM application_work`).toEqual([
        { name: "execution", generation: 0 },
      ]);
      expect(yield* claimWork).toBe(true);
    }),
  );
});

test("a slow lane finishes safely and a replacement alarm resumes with the next lane", async () => {
  await runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const sql = yield* SqlClient.SqlClient;
      const entered = yield* Deferred.make<void>();
      const visited: string[] = [];
      const lanes = [
        {
          name: "slow",
          run: Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.sleep("46 seconds")),
            Effect.tap(() =>
              Effect.sync(() => {
                visited.push("slow");
              }),
            ),
          ),
        },
        {
          name: "fast",
          run: Effect.sync(() => {
            visited.push("fast");
          }),
        },
      ];
      const ticking = yield* withWorkBudget(runWorkLanes("cursor", lanes)).pipe(
        Effect.flip,
        Effect.forkScoped,
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust("46 seconds");
      expect(yield* Fiber.join(ticking)).toBeInstanceOf(DeferredWork);
      expect(visited).toEqual(["slow"]);
      expect(yield* sql`SELECT at FROM application_clock WHERE name = 'cursor'`).toEqual([
        { at: 1 },
      ]);
      yield* withWorkBudget(
        runWorkLanes(
          "cursor",
          [lanes[0]!, lanes[1]!].map((lane) => ({
            name: lane.name,
            run: Effect.sync(() => {
              visited.push(lane.name);
            }),
          })),
        ),
      );
      expect(visited).toEqual(["slow", "fast", "slow"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("failed and explicitly deferred lanes let siblings advance, while caller cancellation retains its cursor", async () => {
  const { logs, restore } = captureDiagnostics();
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        yield* migrate;
        const failure = Object.assign(new Error("private upstream"), { code: "REMOTE_DOWN" });
        let siblings = 0;
        const fast = {
          name: "fast",
          run: Effect.sync(() => {
            siblings++;
          }),
        };
        const requestId = crypto.randomUUID();
        expect(
          (yield* withWorkBudget(
            runWorkLanes("failed", [{ name: "failed", run: Effect.fail(failure) }, fast]),
            requestId,
          ).pipe(Effect.flip)).cause,
        ).toBe(failure);
        expect(logs.join("")).toContain(requestId);
        expect(
          yield* withWorkBudget(
            runWorkLanes("deferred", [
              { name: "deferred", run: Effect.fail(new DeferredWork()) },
              fast,
            ]),
          ).pipe(Effect.flip),
        ).toBeInstanceOf(DeferredWork);
        expect(siblings).toBe(2);
        const selfInterrupted = yield* withWorkBudget(
          runWorkLanes("self-interrupted", [
            { name: "interrupted", run: Effect.failCause(Cause.interrupt(123)) },
            fast,
          ]),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(selfInterrupted)).toBe(true);
        expect(siblings).toBe(2);
        expect(logs.filter((line) => line.includes('"outcome":"failed"'))).toHaveLength(1);
        expect(logs.join("")).toContain("REMOTE_DOWN");
        expect(logs.join("")).not.toContain("private upstream");
        const defect = yield* withWorkBudget(
          runWorkLanes("defect", [{ name: "defect", run: Effect.die("private non-error defect") }]),
        ).pipe(Effect.flip);
        expect(defect.cause).toBeInstanceOf(Error);
        expect(logs.join("")).not.toContain("private non-error defect");
        const entered = yield* Deferred.make<void>();
        const cancelled = yield* withWorkBudget(
          runWorkLanes("cancelled", [
            {
              name: "waiting",
              run: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
            },
            fast,
          ]),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(cancelled);
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`SELECT at FROM application_clock WHERE name = 'cancelled'`).toEqual([
          { at: 1 },
        ]);
      }),
    );
  } finally {
    restore();
  }
});

test("maintenance checkpoints advance only after completion and remain idle until due", async () => {
  await runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      let visits = 0;
      const step = maintenanceWork(
        "maintenance.test",
        Effect.sync(() => {
          visits++;
        }),
      );
      yield* step;
      yield* step;
      expect(visits).toBe(1);
      yield* TestClock.adjust("5 minutes");
      yield* step;
      expect(visits).toBe(2);
      expect(yield* Clock.currentTimeMillis).toBeGreaterThanOrEqual(300_000);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("Handle heads bound storage work and let other users pass a large failed prefix across replacement", async () => {
  const { restore } = captureDiagnostics();
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        yield* migrate;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i < 5000)
        INSERT INTO intake_pending(guid, handle, payload) SELECT 'slow-' || i, 'slow',
          json_object('id', i, 'guid', 'slow-' || i, 'handle', 'slow', 'createdAt', i, 'text', 'queued', 'fromMe', json('false')) FROM n`;
        for (let i = 0; i < 5; i++)
          yield* sql`INSERT INTO intake_pending(guid, handle, payload) VALUES (${`fast-${i}`}, ${`fast-${i}`},
        ${JSON.stringify({ id: i + 5001, guid: `fast-${i}`, handle: `fast-${i}`, createdAt: i + 5001, text: "ready", fromMe: false })})`;
        const [before] = yield* sql<{ n: number }>`SELECT total_changes() AS n`;
        const seen: string[] = [];
        const receive = (row: { handle: string }) =>
          row.handle === "slow"
            ? Effect.fail(new Error("temporarily unavailable"))
            : Effect.sync(() => {
                seen.push(row.handle);
              });
        let queue = yield* intakeQueue;
        yield* exhaustedAlarm(queue.drain(receive, () => Effect.void));
        expect(seen).toEqual([]);
        yield* withWorkBudget(queue.drain(receive, () => Effect.void));
        expect(seen).toHaveLength(4);
        const [changes] = yield* sql<{ n: number }>`SELECT total_changes() AS n`;
        expect(changes!.n - before!.n).toBeLessThan(30);
        expect(yield* sql`SELECT COUNT(*) AS n FROM intake_pending WHERE retry_at > 0`).toEqual([
          { n: 1 },
        ]);
        queue = yield* intakeQueue;
        yield* withWorkBudget(queue.drain(receive, () => Effect.void));
        expect(new Set(seen).size).toBe(5);
        expect(yield* sql`SELECT COUNT(*) AS n FROM intake_pending`).toEqual([{ n: 5000 }]);
        yield* TestClock.adjust("1 second");
        yield* finishApplicationWork(yield* scheduledApplicationWork, false);
        expect(yield* nextApplicationWake).toBe(30_000);
        const plan =
          yield* sql`EXPLAIN QUERY PLAN SELECT handle FROM intake_handle WHERE retry_at <= ${0} ORDER BY retry_at, head LIMIT ${5}`;
        expect(JSON.stringify(plan)).toContain("intake_handle_due");
        expect(
          JSON.stringify(
            yield* sql`EXPLAIN QUERY PLAN SELECT id, handle, payload FROM intake_pending WHERE handle = ${"slow"} ORDER BY id LIMIT ${5}`,
          ),
        ).toContain("intake_pending_handle");
      }).pipe(Effect.provide(TestClock.layer())),
    );
  } finally {
    restore();
  }
});

test("lane retries survive replacement without delaying healthy work or spinning on overdue turn probes", async () => {
  const { restore } = captureDiagnostics();
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        yield* migrate;
        const sql = yield* SqlClient.SqlClient;
        let failing = true;
        let attempts = 0;
        let healthy = 0;
        const lanes = [
          {
            name: "turns",
            run: Effect.gen(function* () {
              attempts++;
              if (failing) return yield* Effect.fail(new Error("private upstream"));
              yield* sql`DELETE FROM application_work WHERE name = 'turn:one'`;
              return undefined;
            }),
          },
          {
            name: "intake",
            run: Effect.sync(() => {
              healthy++;
            }),
          },
        ];
        yield* scheduleWork("turn:one", 0);
        const original = yield* scheduledApplicationWork;
        expect(
          yield* withWorkBudget(runWorkLanes("execution.cursor", lanes)).pipe(Effect.flip),
        ).toBeInstanceOf(WorkLaneFailure);
        yield* finishApplicationWork(original, false);
        expect(yield* nextApplicationWake).toBe(30_000);
        yield* withWorkBudget(runWorkLanes("execution.cursor", lanes));
        expect([attempts, healthy]).toEqual([1, 2]);
        yield* TestClock.adjust("30 seconds");
        yield* withWorkBudget(runWorkLanes("execution.cursor", lanes)).pipe(Effect.flip);
        expect(yield* nextApplicationWake).toBe(90_000);
        failing = false;
        yield* TestClock.adjust("60 seconds");
        yield* withWorkBudget(runWorkLanes("execution.cursor", lanes));
        expect([attempts, healthy]).toEqual([3, 4]);
        expect(yield* sql`SELECT 1 FROM application_work WHERE name GLOB 'lane:*'`).toEqual([]);
        failing = true;
        yield* withWorkBudget(runWorkLanes("execution.cursor", lanes)).pipe(Effect.flip);
        expect(yield* sql`SELECT attempts FROM application_work WHERE name GLOB 'lane:*'`).toEqual([
          { attempts: 1 },
        ]);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  } finally {
    restore();
  }
});

test("nested failure backoff belongs to its lane and cannot hold health or notifications behind executor recovery", async () => {
  const { restore } = captureDiagnostics();
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        yield* migrate;
        const sql = yield* SqlClient.SqlClient;
        yield* scheduleWork("lane:alarm.cursor:execution", 0);
        const failed = yield* withWorkBudget(
          runWorkLanes("alarm.cursor", [
            {
              name: "execution",
              run: runWorkLanes("execution.cursor", [
                { name: "turns", run: Effect.fail(new Error("private error")) },
              ]),
            },
          ]),
        ).pipe(Effect.flip);
        expect(failed).toBeInstanceOf(WorkLaneFailure);
        expect(
          yield* sql`SELECT name FROM application_work WHERE name = 'lane:alarm.cursor:execution'`,
        ).toEqual([]);
        yield* sql`DELETE FROM application_work`;
        yield* sql`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i < 10000)
        INSERT INTO application_work(name, due) SELECT 'turn:' || i, 0 FROM n`;
        for (const [name, due] of [
          ["lane:alarm.cursor:execution", 300_000],
          ["lane:execution.cursor:turns", 30_000],
          ["lane:alarm.cursor:notifications", 40_000],
          ["notifications", 0],
          ["messaging-health", 20_000],
          ["intake", 0],
        ] as const)
          yield* scheduleWork(name, due);
        expect(yield* scheduledApplicationWork).toHaveLength(5);
        expect(yield* nextApplicationWake).toBe(20_000);
        yield* sql`DELETE FROM application_work WHERE name = 'messaging-health'`;
        expect(yield* nextApplicationWake).toBe(40_000);
        yield* sql`DELETE FROM application_work WHERE name = 'lane:alarm.cursor:notifications'`;
        expect(yield* nextApplicationWake).toBe(1);
        expect(
          JSON.stringify(
            yield* sql`EXPLAIN QUERY PLAN SELECT MIN(due) FROM application_work INDEXED BY work_turn_due WHERE name GLOB 'turn:*'`,
          ),
        ).toContain("work_turn_due");
        expect(
          JSON.stringify(
            yield* sql`EXPLAIN QUERY PLAN SELECT name, due FROM application_work INDEXED BY work_fixed WHERE name NOT GLOB 'turn:*' AND name != 'retry'`,
          ),
        ).toContain("work_fixed");
      }).pipe(Effect.provide(TestClock.layer())),
    );
  } finally {
    restore();
  }
});
