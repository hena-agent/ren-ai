import { Effect, Result } from "effect";
import { expect, test, vi } from "vitest";
import { fromPartial } from "@total-typescript/shoehorn";
import { Session } from "@opencode/schema/session";
import { SessionInbox } from "@opencode/schema/session-inbox";
import { SessionMessage } from "@opencode/schema/session-message";
import { MissingSession, type PersonaRuntime } from "../opencode/runtime.ts";
import { relationshipFixture } from "../../test/relationship.test-helper.ts";
import { withContactDatabase } from "../discovery/contact.test-helper.ts";
import { stoppedConversations, stopSession } from "./stop.ts";
import { runtimeStatus, runtimeStatusRequest } from "./runtime-status.ts";
import { conversationEndings } from "./end.ts";
import { retainedSessions } from "./retained.ts";
import type { ContactDiagnostic } from "../discovery/diagnostics.ts";

test.each([false, true])(
  "runtime status exposes pre-assistant failure only when idle (running: %s)",
  (running) =>
    withContactDatabase(
      Effect.gen(function* () {
        const f = yield* relationshipFixture;
        const host = fromPartial<PersonaRuntime>({
          sessions: {
            get: () => Effect.succeed(fromPartial<Session.Info>({ outcome: "failed" })),
            inbox: () => Effect.succeed([]),
          },
        });
        const service = yield* runtimeStatus(host, () => Effect.succeed(running), f.ending);
        const handler = runtimeStatusRequest(service, Effect.runPromise);
        const response = yield* Effect.promise(() =>
          handler(new Request(`https://api.test/operator/conversations?id=${f.conversation.id}`)),
        );
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.json())).toEqual({
          state: running ? "running" : "idle",
          failed: !running,
          pending: 0,
          nextWakeAt: null,
        });
      }),
    ),
);

test("termination stops execution and cancels inbox work once across application restarts", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const f = yield* relationshipFixture;
      const events: string[] = [];
      let pending = [fromPartial<SessionInbox.Info>({ id: SessionMessage.ID.make("msg_pending") })];
      const host = fromPartial<PersonaRuntime>({
        sessions: {
          writable: (_id: Session.ID, writable: boolean) =>
            Effect.sync(() => {
              expect(writable).toBe(false);
            }),
          interrupt: () =>
            Effect.sync(() => {
              events.push("interrupt");
              return true;
            }),
          wait: () =>
            Effect.sync(() => {
              events.push("wait");
            }),
          inbox: () => Effect.sync(() => pending),
          cancelInbox: () =>
            Effect.sync(() => {
              events.push("cancel");
              pending = [];
            }),
          get: () =>
            Effect.succeed(
              fromPartial<Session.Info>({ id: Session.ID.make(f.conversation.sessionID) }),
            ),
        },
      });
      const logs: ContactDiagnostic[] = [];
      const initiallyActive = yield* runtimeStatus(host, () => Effect.succeed(false), f.ending);
      expect((yield* initiallyActive.inspect(f.conversation.id))?.state).toBe("idle");
      const stopped = yield* stoppedConversations(host, logs.push.bind(logs));
      yield* f.ending.end(f.conversation.sessionID, "bye", "stop");
      yield* stopped.tick;
      expect(events).toEqual(["interrupt", "cancel", "wait"]);
      expect(
        (yield* f.sql<{ at: number }>`SELECT stopped_at AS at FROM conversation_end`)[0]!.at,
      ).toBeGreaterThan(0);
      yield* stopped.tick;
      expect(events).toHaveLength(3);
      yield* stopped.resume;
      yield* stopped.tick;
      expect(events).toHaveLength(3);
      expect(logs[0]).toMatchObject({
        stage: "session.stop",
        outcome: "completed",
        sessionId: f.conversation.sessionID,
      });
      const service = yield* runtimeStatus(host, () => Effect.succeed(false), f.ending);
      expect(yield* service.inspect(f.conversation.id)).toEqual({
        state: "idle",
        failed: false,
        pending: 0,
        nextWakeAt: null,
      });
      expect(yield* service.inspect(999)).toBeUndefined();
      const running = yield* runtimeStatus(host, () => Effect.succeed(true), f.ending);
      expect((yield* running.inspect(f.conversation.id))?.state).toBe("running");
      const missing = fromPartial<PersonaRuntime>({
        sessions: {
          writable: () => Effect.fail(new MissingSession({ message: "missing" })),
          get: () => Effect.fail(new MissingSession({ message: "missing" })),
          interrupt: () => Effect.fail(new MissingSession({ message: "missing" })),
        },
      });
      yield* stopSession(missing, f.conversation.sessionID);
      yield* f.sql`UPDATE conversation_end SET stopped_at = NULL`;
      const missingStop = yield* stoppedConversations(missing, logs.push.bind(logs));
      yield* missingStop.tick;
      expect(
        (yield* f.sql<{ at: number | null }>`SELECT stopped_at AS at FROM conversation_end`)[0]!.at,
      ).not.toBeNull();
      const gone = yield* runtimeStatus(missing, () => Effect.succeed(false), f.ending);
      expect((yield* gone.inspect(f.conversation.id))?.state).toBe("missing");
      pending = [fromPartial<SessionInbox.Info>({ id: SessionMessage.ID.make("msg_uncancelled") })];
      const uncooperative = {
        ...host,
        sessions: { ...host.sessions, cancelInbox: () => Effect.void },
      };
      expect(
        Result.isFailure(
          yield* Effect.result(stopSession(uncooperative, f.conversation.sessionID)),
        ),
      ).toBe(true);
      const failure = new Error("private upstream payload", {
        cause: Object.assign(new Error("private cause"), { code: "EXECUTOR_DOWN" }),
      });
      const unavailable = yield* runtimeStatus(host, () => Effect.fail(failure), f.ending);
      const handler = runtimeStatusRequest(unavailable, Effect.runPromise);
      const capture: string[] = [];
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        capture.push(String(chunk));
        return true;
      });
      try {
        const response = yield* Effect.promise(() =>
          handler(new Request(`https://api.test/operator/conversations?id=${f.conversation.id}`)),
        );
        expect(yield* Effect.promise(() => response.json())).toEqual({
          state: "unavailable",
          pending: null,
          nextWakeAt: null,
        });
        expect(capture.join("")).toContain(response.headers.get("x-request-id"));
        expect(capture.join("")).toContain("EXECUTOR_DOWN");
        expect(capture.join("")).not.toMatch(/private upstream payload|private cause|821099999999/);
      } finally {
        stderr.mockRestore();
      }
      yield* f.sql`UPDATE conversation_end SET stopped_at = NULL WHERE conversation_id = ${f.conversation.id}`;
      const failedStop = yield* stoppedConversations(
        { ...host, sessions: { ...host.sessions, interrupt: () => Effect.fail(failure) } },
        (event) => logs.push(event),
      );
      yield* failedStop.resume;
      yield* failedStop.tick;
      expect(logs.at(-1)).toMatchObject({
        stage: "session.stop",
        outcome: "failed",
        causeCode: "EXECUTOR_DOWN",
      });
    }),
  );
});

test("an unavailable farewell observation cannot block the service notice or masquerade as an unavailable executor", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const f = yield* relationshipFixture;
      yield* f.ending.end(f.conversation.sessionID, "private farewell", "observation");
      yield* f.sql`INSERT INTO send(handle, conversation_id, kind, content, tool_call_id, state, recorded_at, updated_at)
      VALUES (${f.conversation.handle}, ${f.conversation.id}, 'text', 'private farewell', 'observation:farewell:0', 'uncertain', 0, 0)`;
      const faulted = yield* conversationEndings(
        f.app.directory,
        f.app.sends,
        { ...f.fake.messages, recent: () => Effect.fail(new Error("upstream unavailable")) },
        f.ui.gestures,
        f.personas,
        (event) => f.logs.push(event),
      );
      yield* faulted.tick;
      expect(f.fake.bubbles).toHaveLength(1);
      expect(f.fake.bubbles[0]?.text).toContain("[RenAI]");
      yield* faulted.observe(f.conversation.id);
      expect(f.logs.at(-1)).toMatchObject({ stage: "ending.observe.farewell", outcome: "failed" });
      const host = fromPartial<PersonaRuntime>({
        sessions: {
          get: () => Effect.succeed(fromPartial<Session.Info>({})),
          inbox: () => Effect.succeed([]),
        },
      });
      const service = yield* runtimeStatus(host, () => Effect.succeed(true), faulted);
      expect((yield* service.inspect(f.conversation.id))?.state).toBe("running");
      const hanging = yield* conversationEndings(
        f.app.directory,
        f.app.sends,
        { ...f.fake.messages, recent: () => Effect.never },
        f.ui.gestures,
        f.personas,
        (event) => f.logs.push(event),
      );
      const bounded = yield* runtimeStatus(host, () => Effect.succeed(true), hanging);
      expect((yield* bounded.inspect(f.conversation.id))?.state).toBe("running");
    }),
  );
});

test.each(["missing", "untagged", "tagged"])(
  "session retention handles %s executor failures without discarding review history",
  async (kind) => {
    await withContactDatabase(
      Effect.gen(function* () {
        const f = yield* relationshipFixture;
        const failure =
          kind === "missing"
            ? new MissingSession({ message: "Session missing" })
            : kind === "untagged"
              ? new Error("executor rename failed")
              : Object.assign(new Error("executor rename failed"), {
                  _tag: "ExecutorFailure",
                });
        const host = fromPartial<PersonaRuntime>({
          sessions: {
            writable: () => Effect.void,
            interrupt: () => Effect.succeed(false),
            inbox: () => Effect.succeed([]),
            wait: () => Effect.void,
            rename: () => Effect.fail(failure),
          },
        });
        yield* f.sql`INSERT INTO retained_session (session_id, handle, title) VALUES (${f.conversation.sessionID}, ${f.conversation.handle}, 'retained')`;
        const retained = yield* retainedSessions(host);
        const result = yield* Effect.result(retained.resume);
        expect(Result.isFailure(result)).toBe(kind !== "missing");
        expect(Result.isFailure(result) ? result.failure : undefined).toBe(
          kind === "missing" ? undefined : failure,
        );
        expect((yield* f.sql`SELECT session_id FROM retained_session`).length).toBe(1);
        expect(yield* f.sql`SELECT stopped FROM retained_session`).toEqual([
          { stopped: Number(kind === "missing") },
        ]);
      }),
    );
  },
);
