import { Session } from "@opencode/schema";
import { fromPartial } from "@total-typescript/shoehorn";
import { Cause, Clock, Effect, Exit } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { conversations } from "../conversations/conversations.ts";
import { migrate } from "../database.ts";
import { scheduleWork } from "../scheduling.ts";
import { nextApplicationWake } from "../scheduling.ts";
import { withWorkBudget } from "../work-budget.ts";
import { captureDiagnostics } from "../../test/diagnostics.test-helper.ts";
import { registration, runMessagingTest } from "../../test/messaging.test-helper.ts";
import { exhaustedAlarm } from "../../test/work-budget.test-helper.ts";
import type { PersonaRuntime } from "./runtime.ts";
import { releaseQuotaTurns, turnWork } from "./turn-work.ts";

const setup = Effect.gen(function* () {
  yield* migrate;
  return { sql: yield* SqlClient.SqlClient, directory: yield* conversations };
});

test("a poison session backs off durably while healthy inspection advances; fresh generations and cancellation survive", async () => {
  const { logs, restore } = captureDiagnostics();
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const { sql, directory } = yield* setup;
        const poison = yield* directory.create(registration("private@example.test", "ses_poison"));
        const healthy = yield* directory.create(
          registration("healthy@example.test", "ses_healthy"),
        );
        let failing = true;
        const visited: string[] = [];
        const inspect = yield* turnWork(
          fromPartial<PersonaRuntime>({}),
          directory,
          (conversation) =>
            Effect.gen(function* () {
              visited.push(conversation.sessionID);
              if (failing && conversation.id === poison.id)
                return yield* Effect.fail(
                  Object.assign(new Error("private upstream"), { code: "INSPECT_DOWN" }),
                );
              return undefined;
            }),
        );
        const requestId = crypto.randomUUID();
        yield* sql`INSERT INTO failed_turn(session_id, fingerprint, failures, quota, failed_at, retry_at) VALUES ('ses_poison', 'failed', 1, 0, 0, 0)`;
        yield* withWorkBudget(inspect.inspect(poison, 0), requestId);
        yield* inspect.inspect(healthy, 0);
        expect(visited).toEqual(["ses_poison", "ses_healthy"]);
        expect(yield* nextApplicationWake).toBe(30_000);
        expect(
          yield* sql`SELECT due, attempts FROM application_work WHERE name = 'turn:ses_poison'`,
        ).toEqual([{ due: 30_000, attempts: 1 }]);
        const replacement = yield* turnWork(fromPartial<PersonaRuntime>({}), directory, () =>
          Effect.fail(new Error("still down")),
        );
        yield* replacement.inspect(poison, 29_999);
        expect(visited).toHaveLength(2);
        yield* TestClock.adjust("30 seconds");
        yield* replacement.inspect(poison, 30_000);
        expect(
          yield* sql`SELECT due, attempts FROM application_work WHERE name = 'turn:ses_poison'`,
        ).toEqual([{ due: 90_000, attempts: 2 }]);
        failing = false;
        yield* inspect.inspect(poison, 90_000);
        expect(yield* sql`SELECT name FROM application_work`).toEqual([{ name: "metrics-report" }]);
        yield* scheduleWork("turn:ses_healthy", 0);
        const fresh = yield* turnWork(fromPartial<PersonaRuntime>({}), directory, () =>
          scheduleWork("turn:ses_healthy", 0).pipe(
            Effect.asVoid,
            Effect.provideService(SqlClient.SqlClient, sql),
          ),
        );
        yield* fresh.inspect(healthy, 30_000);
        expect(
          yield* sql`SELECT generation FROM application_work WHERE name = 'turn:ses_healthy'`,
        ).toEqual([{ generation: 1 }]);
        const interrupted = yield* turnWork(fromPartial<PersonaRuntime>({}), directory, () =>
          Effect.failCause(Cause.interrupt(1)),
        );
        expect(Exit.isFailure(yield* interrupted.inspect(healthy, 30_000).pipe(Effect.exit))).toBe(
          true,
        );
        expect(logs.filter((line) => line.includes('"stage":"session.inspect"'))).toHaveLength(2);
        expect(logs.join("")).toContain(requestId);
        expect(logs.join("")).toContain("INSPECT_DOWN");
        expect(logs.join("")).not.toContain("private upstream");
        expect(logs.join("")).not.toContain("private@example.test");
      }).pipe(Effect.provide(TestClock.layer())),
    );
  } finally {
    restore();
  }
});

test("quota release persists a bounded restartable resume queue, fences outgoing attempts and never replays completed work", async () => {
  const { logs, restore } = captureDiagnostics();
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const { sql, directory } = yield* setup;
        const entries = [];
        for (let i = 0; i < 8; i++) {
          const conversation = yield* directory.create({
            ...registration(`quota-${i}@example.test`, `ses_quota${i}`),
            personaID: `persona${Math.floor(i / 5)}`,
          });
          entries.push(conversation);
          yield* sql`INSERT INTO failed_turn(session_id, fingerprint, failures, quota, failed_at, retry_at) VALUES (${conversation.sessionID}, 'checkpoint', 1, 1, 0, 0)`;
        }
        yield* scheduleWork("turn:ses_quota0", 100);
        yield* releaseQuotaTurns;
        expect(yield* sql`SELECT 1 FROM failed_turn`).toEqual([]);
        expect(yield* sql`SELECT COUNT(*) AS n FROM application_work WHERE resume = 1`).toEqual([
          { n: 8 },
        ]);
        yield* sql`INSERT INTO send(handle, conversation_id, kind, content, tool_call_id, state, recorded_at, updated_at)
        VALUES (${entries[0]!.handle}, ${entries[0]!.id}, 'text', 'private text', 'uncertain-call', 'uncertain', 0, 0)`;
        const retried: string[] = [];
        const inspected: string[] = [];
        const host = fromPartial<PersonaRuntime>({
          retry: (id: Session.ID) =>
            Effect.sync(() => {
              retried.push(id);
            }),
        });
        const open = () =>
          turnWork(host, directory, (conversation) =>
            Effect.sync(() => {
              inspected.push(conversation.sessionID);
            }),
          );
        let work = yield* open();
        yield* work.inspect(entries[0]!, 0);
        expect(inspected).toEqual([]);
        yield* exhaustedAlarm(work.resumes);
        expect(retried).toEqual([]);
        yield* withWorkBudget(work.resumes);
        expect(retried).toEqual(["ses_quota1", "ses_quota2", "ses_quota3", "ses_quota4"]);
        expect(inspected).toEqual(["ses_quota0"]);
        expect(yield* sql`SELECT COUNT(*) AS n FROM application_work WHERE resume = 1`).toEqual([
          { n: 3 },
        ]);
        work = yield* open();
        yield* withWorkBudget(work.resumes);
        yield* work.resumes;
        expect(retried).toHaveLength(7);
        expect(new Set(retried).size).toBe(7);
        yield* sql`INSERT INTO application_work(name, due, resume) VALUES ('turn:ses_removed', 0, 1)`;
        yield* work.resumes;
        // Cancel at the storage claim boundary, after selection but before RETURNING.
        yield* sql`INSERT INTO application_work(name, due, resume) VALUES ('turn:ses_cancelled', 0, 1)`;
        yield* sql`CREATE TRIGGER cancel_resume BEFORE UPDATE OF resume ON application_work
        WHEN OLD.name = 'turn:ses_cancelled' BEGIN
          DELETE FROM application_work WHERE name = OLD.name; SELECT RAISE(IGNORE); END`;
        yield* work.resumes;
        expect(
          yield* sql`SELECT 1 FROM application_work WHERE name = 'turn:ses_cancelled'`,
        ).toEqual([]);
        yield* sql`UPDATE application_work SET resume = 1 WHERE name = 'turn:ses_quota6'`;
        yield* Effect.all([work.resumes, work.resumes], { concurrency: "unbounded" });
        expect(retried.filter((id) => id === "ses_quota6")).toHaveLength(2);
        const plan =
          yield* sql`EXPLAIN QUERY PLAN SELECT name, generation FROM application_work INDEXED BY work_resume_due WHERE resume = 1 AND due <= 0 ORDER BY due, name LIMIT 5`;
        expect(JSON.stringify(plan)).toContain("work_resume_due");
        // A failed retry is inspected, never blindly re-submitted. Caller cancellation is preserved too.
        yield* sql`UPDATE application_work SET resume = 1 WHERE name = 'turn:ses_quota7'`;
        const failed = yield* turnWork(
          fromPartial<PersonaRuntime>({
            retry: () => Effect.fail(new Error("private failed retry")),
          }),
          directory,
          () => Effect.void,
        );
        yield* failed.resumes;
        expect(logs.join("")).toContain('"stage":"session.resume"');
        expect(logs.join("")).not.toContain("private failed retry");
        expect(logs.join("")).not.toContain("private text");
        yield* sql`UPDATE application_work SET resume = 1 WHERE name = 'turn:ses_quota7'`;
        const cancelled = yield* turnWork(
          fromPartial<PersonaRuntime>({ retry: () => Effect.failCause(Cause.interrupt(1)) }),
          directory,
          () => Effect.void,
        );
        expect(Exit.isFailure(yield* cancelled.resumes.pipe(Effect.exit))).toBe(true);
        expect(
          yield* sql`SELECT resume, due FROM application_work WHERE name = 'turn:ses_quota7'`,
        ).toEqual([{ resume: 0, due: (yield* Clock.currentTimeMillis) + 30_000 }]);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  } finally {
    restore();
  }
});
