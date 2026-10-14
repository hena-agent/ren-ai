import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import { fromPartial } from "@total-typescript/shoehorn";
import { Clock, DateTime, Effect, Stream, type Scope } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { conversations } from "../conversations/conversations.ts";
import { migrate } from "../database.ts";
import {
  messagingFixture,
  registration,
  runMessagingTest,
} from "../../test/messaging.test-helper.ts";
import { failedTurns } from "./failed-turns.ts";
import { MissingSession, type PersonaRuntime } from "./runtime.ts";

const fixture = () => {
  let now = 0;
  const states = new Map<
    string,
    { idle?: number; outcome?: Session.Info["outcome"]; error?: string; user?: boolean }
  >();
  const calls: string[] = [];
  const alerts: string[] = [];
  const host = fromPartial<PersonaRuntime>({
    outcomes: Stream.die("Recovery must not subscribe to a live stream"),
    sessions: {
      get: (id: Session.ID) =>
        Effect.suspend(() => {
          const state = states.get(id.slice(4));
          return state
            ? Effect.succeed(
                fromPartial<Session.Info>({
                  id,
                  outcome: state.outcome,
                  time: state.idle === undefined ? {} : { idle: DateTime.makeUnsafe(state.idle) },
                }),
              )
            : Effect.fail(new MissingSession({ message: "missing" }));
        }),
      inbox: () => Effect.succeed([]),
      messages: ({ sessionID }: { sessionID: Session.ID }) =>
        Effect.sync(() => {
          const state = states.get(sessionID.slice(4))!;
          return state.user
            ? [fromPartial<SessionMessage.Info>({ type: "user" })]
            : state.error
              ? [
                  fromPartial<SessionMessage.Info>({
                    type: "assistant",
                    error: { type: state.error },
                  }),
                ]
              : [];
        }),
    },
    retry: (id: Session.ID) =>
      Effect.sync(() => {
        calls.push(id.slice(4));
        const state = states.get(id.slice(4))!;
        state.idle = (state.idle ?? 0) + 1;
      }),
  });
  const notifications = {
    raise: (name: string) =>
      Effect.sync(() => {
        alerts.push(name);
      }),
    clear: (name: string) =>
      Effect.sync(() => {
        alerts.push(`clear:${name}`);
      }),
  };
  const clock = Effect.runSync(Clock.Clock);
  const run = <A, E>(
    body: Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>,
    filename = ":memory:",
  ) =>
    runMessagingTest(
      body.pipe(
        Effect.provideService(Clock.Clock, {
          currentTimeNanos: clock.currentTimeNanos,
          currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
          monotonicTimeNanos: clock.monotonicTimeNanos,
          monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
          currentTimeMillis: Effect.sync(() => now),
          currentTimeMillisUnsafe: () => now,
          sleep: (duration) => clock.sleep(duration),
        }),
      ),
      filename,
    );
  const open = Effect.gen(function* () {
    yield* migrate;
    const directory = yield* conversations;
    const scheduler = yield* failedTurns(host, directory, notifications);
    return { directory, scheduler, sql: yield* SqlClient.SqlClient };
  });
  return {
    states,
    calls,
    alerts,
    host,
    notifications,
    run,
    open,
    time: (value: number) => {
      now = value;
    },
  };
};

test.each([false, true])(
  "actor replacement retains the %s quota/provider deadline and probe rotation",
  async (quota) => {
    const { root } = await messagingFixture("durable-delay-");
    const filename = join(root, "application.sqlite");
    const f = fixture();
    f.states.set("first", {
      idle: 1,
      outcome: "failed",
      error: quota ? "QuotaExceededError" : "AuthenticationError",
    });
    f.states.set("second", { idle: 1, outcome: "failed", error: "AuthenticationError" });
    try {
      await f.run(
        Effect.gen(function* () {
          const { directory, scheduler } = yield* f.open;
          yield* directory.create(registration("first@example.com", "ses_first"));
          yield* directory.create(registration("second@example.com", "ses_second"));
          yield* scheduler.tick;
          expect(f.calls).toEqual([]);
        }),
        filename,
      );
      const delay = quota ? 900_000 : 1000;
      f.time(delay - 1);
      await f.run(
        Effect.gen(function* () {
          const { scheduler, sql } = yield* f.open;
          expect(f.calls).toEqual([]);
          expect(
            (yield* sql<{ retry_at: number }>`SELECT retry_at FROM failed_turn`)[0]!.retry_at,
          ).toBe(delay);
          f.time(delay);
          yield* scheduler.tick;
          expect(f.calls).toEqual(quota ? ["first"] : ["first", "second"]);
          yield* scheduler.tick;
        }),
        filename,
      );
      f.time(quota ? 1_799_999 : 2999);
      await f.run(
        Effect.gen(function* () {
          const { scheduler } = yield* f.open;
          expect(f.calls).toHaveLength(quota ? 1 : 2);
          f.time(quota ? 1_800_000 : 3000);
          yield* scheduler.tick;
          expect(f.calls).toEqual(
            quota ? ["first", "second"] : ["first", "second", "first", "second"],
          );
          yield* scheduler.tick;
          if (!quota) expect(f.alerts).toContain("conversation-turn-failing:ses_first");
          f.states.set("second", { idle: 4, outcome: "succeeded" });
          yield* scheduler.tick;
          if (quota) {
            expect(f.calls).toEqual(["first", "second", "first"]);
            expect(f.alerts.filter((name) => name === "go-cap")).toHaveLength(1);
          }
        }),
        filename,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("journal review is durable, deduplicated, and catches sends added after failure observation", async () => {
  const f = fixture();
  f.states.set("review", { outcome: "failed", user: true });
  await f.run(
    Effect.gen(function* () {
      const { directory, scheduler, sql } = yield* f.open;
      const conversation = yield* directory.create(
        registration("review@example.com", "ses_review"),
      );
      yield* scheduler.tick;
      yield* sql`INSERT INTO send (handle, conversation_id, kind, content, tool_call_id, state, recorded_at, updated_at)
      VALUES ('review@example.com', ${conversation.id}, 'text', 'sent', 'review-send', 'recorded', 0, 0)`;
      yield* scheduler.tick;
      yield* scheduler.tick;
      f.states.set("review", { outcome: "failed", idle: 2 });
      yield* scheduler.tick;
      f.time(900_000);
      yield* (yield* failedTurns(f.host, directory, f.notifications)).tick;
      expect(f.calls).toEqual([]);
      expect(
        f.alerts.filter((name) => name === "conversation-turn-failing:ses_review"),
      ).toHaveLength(1);
      expect((yield* sql<{ review: number }>`SELECT review FROM failed_turn`)[0]!.review).toBe(1);
      f.states.set("review", { outcome: "succeeded", idle: 3 });
      yield* scheduler.tick;
      expect(yield* sql`SELECT * FROM failed_turn`).toEqual([]);
    }),
  );
});

test("the ten-minute provider alert retains its deadline and deduplication across replacement", async () => {
  const { root } = await messagingFixture("provider-deadline-");
  const filename = join(root, "application.sqlite");
  const f = fixture();
  f.states.set("provider", { idle: 1, outcome: "failed" });
  try {
    await f.run(
      Effect.gen(function* () {
        const { directory, scheduler } = yield* f.open;
        yield* directory.create(registration("provider@example.com", "ses_provider"));
        yield* scheduler.tick;
      }),
      filename,
    );
    f.time(599_999);
    await f.run(
      Effect.gen(function* () {
        const { scheduler } = yield* f.open;
        expect(f.alerts).not.toContain("provider-failing");
        f.time(600_000);
        yield* scheduler.tick;
        expect(f.alerts.filter((name) => name === "provider-failing")).toHaveLength(1);
      }),
      filename,
    );
    f.time(1_200_000);
    await f.run(
      Effect.gen(function* () {
        const { scheduler } = yield* f.open;
        yield* scheduler.tick;
        expect(f.alerts.filter((name) => name === "provider-failing")).toHaveLength(1);
        f.states.set("provider", { idle: 9, outcome: "succeeded" });
        yield* scheduler.tick;
        expect(f.alerts).toContain("clear:provider-failing");
      }),
      filename,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a partial retry response cannot release quota before a new terminal checkpoint", async () => {
  const f = fixture();
  f.states.set("partial", { idle: 1, outcome: "succeeded", error: "QuotaExceededError" });
  await f.run(
    Effect.gen(function* () {
      const { directory, scheduler, sql } = yield* f.open;
      yield* directory.create(registration("partial@example.com", "ses_partial"));
      yield* scheduler.tick;
      f.states.set("partial", { idle: 1, outcome: "succeeded" });
      yield* scheduler.tick;
      expect((yield* sql<{ quota: number }>`SELECT quota FROM failed_turn`)[0]!.quota).toBe(1);
      expect(f.alerts).not.toContain("clear:go-cap");
      f.states.set("partial", { idle: 2, outcome: "succeeded" });
      yield* scheduler.tick;
      expect(yield* sql`SELECT * FROM failed_turn`).toEqual([]);
      expect(f.alerts).toContain("clear:go-cap");
    }),
  );
});

test("forget between due selection and admission cancels the claimed retry; blocked and missing sessions are pruned", async () => {
  const f = fixture();
  f.states.set("cancel", { idle: 1, outcome: "failed" });
  await f.run(
    Effect.gen(function* () {
      const { directory, sql } = yield* f.open;
      yield* directory.create(registration("cancel@example.com", "ses_cancel"));
      let admissions = 0;
      let cancellation = Effect.void;
      const fenced = {
        ...directory,
        admit: <A, E, R>(id: string, action: Effect.Effect<A, E, R>) =>
          directory.admit(
            id,
            Effect.suspend(() =>
              ++admissions === 3 ? cancellation.pipe(Effect.andThen(action)) : action,
            ),
          ),
      };
      const scheduler = yield* failedTurns(f.host, fenced, f.notifications);
      cancellation = scheduler.forget("ses_cancel");
      f.time(1000);
      yield* scheduler.tick;
      expect(f.calls).toEqual([]);
      expect(yield* sql`SELECT * FROM failed_turn`).toEqual([]);
      yield* scheduler.tick;
      yield* directory.block("cancel@example.com");
      yield* scheduler.tick;
      expect(yield* sql`SELECT * FROM failed_turn`).toEqual([]);
      yield* directory.create(registration("missing@example.com", "ses_missing"));
      yield* scheduler.tick;
      expect(f.calls).toEqual([]);
    }),
  );
});
