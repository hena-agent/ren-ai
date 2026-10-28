import { rm } from "node:fs/promises";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { Session } from "@opencode/schema/session";
import { TestLLM } from "@opencode/ai/testing";
import { fakeMessages } from "@ren-ai/imsg/testing";
import { readRuntime } from "@ren-ai/plugin-session-folder/memory";
import { expect, test } from "vitest";
import { messagingFixture, runMessagingTest } from "../../test/messaging.test-helper.ts";
import {
  providerUnavailable,
  scriptedPersona,
  startConversationHost,
} from "../../test/messaging-host.test-helper.ts";
import { readSessionBinding } from "@ren-ai/plugin-session-folder/bindings";
import { emptyMemory, restoreMemory } from "../../test/memory.test-helper.ts";
import { rebuilder } from "./rebuild-session.ts";

test("failed idle replay stays fenced and only rebuild recovery may resume it before live admission", async () => {
  const fixture = await messagingFixture("rebuild-failed-idle-");
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const fake = fakeMessages();
        const llm = yield* scriptedPersona();
        yield* llm.serve(() => providerUnavailable("historical provider unavailable"));
        const { host, original, conversation } = yield* startConversationHost(
          fixture,
          llm,
          fake.messages,
          "failed-replay@example.com",
        );
        expect(
          (yield* host.operator.rebuild(conversation.handle).pipe(Effect.flip)).message,
        ).toContain("Historical replay did not complete successfully");
        const current = (yield* host.conversations.byHandle(conversation.handle))!;
        const id = Session.ID.make(current.sessionID);
        expect((yield* host.sessions.get(id)).outcome).toBe("failed");
        expect(yield* host.conversations.rebuilding(current)).toBe(true);
        expect(
          (yield* Effect.promise(() =>
            readSessionBinding(original.location.directory, current.sessionID),
          )).writable,
        ).toBe(false);
        yield* host.heartbeat.checkTurns([current.sessionID]);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO failed_turn (session_id, fingerprint, failures, quota, failed_at, retry_at)
        VALUES (${current.sessionID}, 'historical-failure', 1, 0, 1, 0)`;
        const requests = (yield* llm.requests()).length;
        yield* host.heartbeat.failedTurns;
        expect((yield* llm.requests()).length).toBe(requests);
        expect(yield* sql`SELECT last_retry_at FROM failed_turn`).toEqual([{ last_retry_at: 0 }]);
        const resume = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        let recovering = true;
        yield* llm.serve((request) => {
          if (!request.tools.some((tool) => tool.name === "update_state"))
            return TestLLM.text("title", "title");
          if (!recovering) return TestLLM.text("recovered", "done");
          recovering = false;
          return Stream.unwrap(
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(resume)),
              Effect.as(
                Stream.fromIterable(
                  TestLLM.tool("retry-state", "update_state", {
                    scope: "life",
                    scores: { mood: 99 },
                    additions: {},
                    remove: [],
                    reason: "Historical retry",
                  }),
                ),
              ),
            ),
          );
        });
        yield* fake.replace([
          {
            id: 1,
            guid: "after-failed-replay",
            handle: conversation.handle,
            createdAt: Date.now() + 1,
            fromMe: false,
            text: "new input after failed replay",
          },
        ]);
        const incoming = yield* host.heartbeat.intake.pipe(Effect.forkScoped);
        yield* Deferred.await(started).pipe(Effect.timeout("5 seconds"));
        expect(
          (yield* Effect.promise(() =>
            readSessionBinding(original.location.directory, current.sessionID),
          )).writable,
        ).toBe(false);
        expect(yield* sql`SELECT guid FROM intake_seen WHERE guid = 'after-failed-replay'`).toEqual(
          [],
        );
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(incoming);
        yield* host.sessions.wait(id);
        expect(yield* host.conversations.rebuilding(current)).toBe(false);
        expect(
          (yield* Effect.promise(() =>
            readSessionBinding(original.location.directory, current.sessionID),
          )).writable,
        ).toBe(true);
        expect(
          (yield* Effect.promise(() => readRuntime(original.location.directory)))?.receipts[
            `${current.sessionID}:retry-state`
          ],
        ).toBeUndefined();
        expect(
          yield* sql`SELECT guid FROM intake_seen WHERE session_id = ${current.sessionID}`,
        ).toEqual([{ guid: "after-failed-replay" }]);
        expect(fake.bubbles).toEqual([]);
        let queued = false;
        const paused = yield* rebuilder(
          host.conversations,
          {
            ...host,
            sessions: {
              ...host.sessions,
              wait: (sessionID) =>
                host.sessions.wait(sessionID).pipe(
                  Effect.tap(() => {
                    if (queued) return Effect.void;
                    queued = true;
                    return host.sessions
                      .prompt({ sessionID, text: "unfinished historical recovery", resume: false })
                      .pipe(Effect.asVoid);
                  }),
                ),
            },
          },
          host.intake.replay,
        );
        expect(
          (yield* paused.rebuild(conversation.handle, true).pipe(Effect.flip)).message,
        ).toContain("Historical replay did not complete successfully");
        const pending = (yield* host.conversations.byHandle(conversation.handle))!;
        expect(yield* host.sessions.inbox(Session.ID.make(pending.sessionID))).toHaveLength(1);
        expect(yield* host.conversations.rebuilding(pending)).toBe(true);
        expect(
          (yield* Effect.promise(() =>
            readSessionBinding(original.location.directory, pending.sessionID),
          )).writable,
        ).toBe(false);
        yield* paused.pending;
        expect(yield* host.conversations.rebuilding(pending)).toBe(false);
      }),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("unread live input waits through stalled and superseded replay, then changes State exactly once", async () => {
  const fixture = await messagingFixture("rebuild-live-");
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const fake = fakeMessages();
        const gates = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
        const starts = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
        const llm = yield* scriptedPersona();
        let historicalTurns = 0;
        let liveWrites = 0;
        yield* llm.serve((request) => {
          if (!request.tools.some((tool) => tool.name === "update_state"))
            return TestLLM.text("title", "title");
          if (JSON.stringify(request.messages).includes("LIVE_UNREAD_INPUT")) {
            if (liveWrites++ === 0)
              return TestLLM.tool("live-change", "update_state", {
                scope: "life",
                scores: { mood: 77 },
                additions: {},
                remove: [],
                reason: "A new live event",
              });
            return TestLLM.text("live done", "live-done");
          }
          const index = historicalTurns++;
          if (index >= 2)
            return JSON.stringify(request.messages).includes("history-send")
              ? TestLLM.text("history done", "history-done")
              : TestLLM.tool("history-send", "send", {
                  text: "Do not send historical effects",
                });
          return Stream.unwrap(
            Deferred.succeed(starts[index]!, undefined).pipe(
              Effect.andThen(Deferred.await(gates[index]!)),
              Effect.as(
                Stream.fromIterable(
                  TestLLM.tool(`history-state-${index}`, "update_state", {
                    scope: "life",
                    scores: { mood: 99 },
                    additions: {},
                    remove: [],
                    reason: "Historical event",
                  }),
                ),
              ),
            ),
          );
        });
        const { host, original, conversation } = yield* startConversationHost(
          fixture,
          llm,
          fake.messages,
          "live@example.com",
        );
        yield* Effect.promise(() =>
          restoreMemory(original.location.directory, {
            ...emptyMemory,
            state: { mood: 50, energy: 50, stress: 50, connection: 50, solitude: 50 },
            shortTerm: "Present life",
          }),
        );
        const first = yield* host.operator.rebuild(conversation.handle).pipe(Effect.forkScoped);
        yield* Deferred.await(starts[0]!).pipe(Effect.timeout("5 seconds"));
        yield* fake.replace([
          {
            id: 1,
            guid: "live-unread",
            handle: conversation.handle,
            text: "LIVE_UNREAD_INPUT",
            fromMe: false,
            createdAt: Date.now() + 1,
          },
        ]);
        const live = yield* host.heartbeat.intake.pipe(Effect.forkScoped);
        yield* Effect.promise(async () => {
          await expect
            .poll(() =>
              Effect.runPromise(sql`SELECT guid FROM intake_pending WHERE guid = 'live-unread'`),
            )
            .toHaveLength(1);
        });
        const second = yield* host.operator.rebuild(conversation.handle).pipe(Effect.forkScoped);
        yield* Deferred.await(starts[1]!).pipe(Effect.timeout("5 seconds"));
        const current = (yield* host.conversations.byHandle(conversation.handle))!;
        expect(yield* sql`SELECT guid FROM intake_seen WHERE guid = 'live-unread'`).toEqual([]);
        yield* Deferred.succeed(gates[0]!, undefined);
        yield* Fiber.join(first);
        expect(yield* host.conversations.rebuilding(current)).toBe(true);
        expect(
          (yield* Effect.promise(() => readRuntime(original.location.directory)))?.state?.mood,
        ).toBe(50);
        yield* Deferred.succeed(gates[1]!, undefined);
        yield* Fiber.join(second);
        yield* Fiber.join(live);
        yield* host.sessions.wait(Session.ID.make(current.sessionID));
        const state = yield* Effect.promise(() => readRuntime(original.location.directory));
        expect(state?.state?.mood).toBe(77);
        expect(
          Object.keys(state!.receipts).filter((key) => key.endsWith(":live-change")),
        ).toHaveLength(1);
        expect(yield* sql`SELECT session_id FROM intake_seen WHERE guid = 'live-unread'`).toEqual([
          { session_id: current.sessionID },
        ]);
        expect(fake.bubbles).toEqual([]);
        const before = liveWrites;
        yield* host.heartbeat.intake;
        expect(liveWrites).toBe(before);
      }),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
