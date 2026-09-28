import { rm } from "node:fs/promises";
import {
  messagingFixture,
  registration,
  runMessagingTest,
  scriptedPersona,
  startTestHost,
  providerUnavailable,
} from "../../test/messaging-host.test-helper.ts";
import { join } from "node:path";
import { TestLLM } from "@opencode/ai/testing";
import { AIError, InvalidRequestError } from "@opencode/ai/schema/errors";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { fakeMessages } from "../messages/messages.fake.ts";
import { fakeGestures } from "../gestures/gestures.fake.ts";
import { outbox } from "../outbox/outbox.ts";

const reopen = (
  open: (llm: TestLLM.TestInterface) => ReturnType<typeof startTestHost>,
  databaseFile: string,
  sessionID: string,
  requests: number,
) =>
  runMessagingTest(
    Effect.gen(function* () {
      const llm = yield* scriptedPersona();
      yield* llm.serve(() => TestLLM.text("recovered", "answer"));
      const host = yield* open(llm);
      expect((yield* host.conversations.byHandle("restart@example.com"))?.sessionID).toBe(
        sessionID,
      );
      yield* host.sessions.wait(Session.ID.make(sessionID)).pipe(Effect.timeout("20 seconds"));
      expect((yield* host.sessions.get(Session.ID.make(sessionID))).outcome).toBe("succeeded");
      const observed = yield* llm.requests();
      expect(observed).toHaveLength(requests);
      yield* Effect.promise(host.disposeOnboarding);
      return observed;
    }),
    databaseFile,
  );

test("a failed Conversation resumes after closing and reopening both persisted database files", async () => {
  const { root, personaDirectory } = await messagingFixture("failed-restart-");
  const databaseFile = join(root, "server.sqlite");
  const hostFile = join(root, "opencode.sqlite");
  let sessionID = "";
  const open = (llm: TestLLM.TestInterface) =>
    startTestHost(root, personaDirectory, llm, fakeMessages().messages, hostFile);
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const llm = yield* scriptedPersona();
        yield* llm.serve(() => providerUnavailable("Unavailable"));
        const host = yield* open(llm);
        const session = yield* host.createSession("persona1");
        sessionID = session.id;
        yield* host.conversations.create(registration("restart@example.com", sessionID));
        yield* host.sessions.prompt({ sessionID: session.id, text: "persisted failure" });
        yield* host.sessions.wait(session.id);
        expect((yield* host.sessions.get(session.id)).outcome).toBe("failed");
        const empty = yield* host.createSession("persona1");
        yield* host.conversations.create(registration("empty@example.com", empty.id));
        yield* Effect.promise(host.disposeOnboarding);
      }),
      databaseFile,
    );
    expect(JSON.stringify(await reopen(open, databaseFile, sessionID, 1))).toContain(
      "persisted failure",
    );
    await reopen(open, databaseFile, sessionID, 0); // A silent successful turn stays successful.
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

test.each([false, true])(
  "an empty-inbox failed turn with outgoing attempt %s recovers safely",
  async (outgoing) => {
    const { root, personaDirectory } = await messagingFixture("empty-recovery-");
    const databaseFile = join(root, "server.sqlite");
    const hostFile = join(root, "opencode.sqlite");
    const fake = fakeMessages();
    const alerts: string[] = [];
    let sessionID = "";
    const open = (llm: TestLLM.TestInterface) =>
      startTestHost(root, personaDirectory, llm, fake.messages, hostFile, {
        raise: (name, detail) =>
          Effect.sync(() => {
            alerts.push(`${name}: ${detail}`);
          }),
        clear: () => Effect.void,
      });
    try {
      await runMessagingTest(
        Effect.gen(function* () {
          const llm = yield* scriptedPersona();
          yield* llm.serve(() =>
            TestLLM.failAfter(
              new AIError({ reason: new InvalidRequestError({ message: "HTTP 400" }) }),
            ),
          );
          const gate = yield* llm.gate();
          const host = yield* open(llm);
          const session = yield* host.createSession("persona1");
          sessionID = session.id;
          yield* host.conversations.create(registration("restart@example.com", sessionID));
          const id = SessionMessage.ID.make("msg_recovery_test");
          yield* host.sessions.prompt({ sessionID: session.id, id, text: "hello" });
          yield* gate.started;
          yield* host.sessions.prompt({ sessionID: session.id, id, text: "hello" });
          yield* gate.release;
          yield* host.sessions.wait(session.id);
          const messages = yield* host.sessions.messages({ sessionID: session.id });
          expect(messages.filter((message) => message.type === "user")).toHaveLength(1);
          expect(messages.some((message) => message.type === "assistant" && message.error)).toBe(
            true,
          );
          expect((yield* host.sessions.get(session.id)).outcome).toBe("succeeded");
          expect(yield* host.sessions.inbox(session.id)).toHaveLength(0);
          if (outgoing) {
            const conversation = (yield* host.conversations.bySession(session.id))!;
            const sends = yield* outbox(
              fake.messages,
              fakeGestures().gestures,
              new Map([["persona1", { timeZone: "Asia/Seoul" }]]),
            );
            yield* sends.send(conversation, "already sent", "call-1");
            expect(fake.bubbles).toHaveLength(1);
          }
          yield* Effect.promise(host.disposeOnboarding);
        }),
        databaseFile,
      );
      await reopen(open, databaseFile, sessionID, outgoing ? 0 : 1);
      expect(fake.bubbles).toHaveLength(outgoing ? 1 : 0);
      expect(alerts.some((detail) => detail.includes("manual review"))).toBe(outgoing);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);

test("a failure before an assistant response still resumes after restart", async () => {
  const { root, personaDirectory } = await messagingFixture("context-restart-");
  const databaseFile = join(root, "server.sqlite");
  const hostFile = join(root, "opencode.sqlite");
  let sessionID = "";
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const llm = yield* scriptedPersona();
        yield* llm.serve(() => TestLLM.text("never", "answer"));
        const messages = fakeMessages().messages;
        const host = yield* startTestHost(
          root,
          personaDirectory,
          llm,
          { ...messages, lastOutgoingStatus: () => Effect.fail(new Error("status unavailable")) },
          hostFile,
        );
        const session = yield* host.createSession("persona1");
        sessionID = session.id;
        yield* host.conversations.create(registration("restart@example.com", sessionID));
        yield* host.sessions.prompt({ sessionID: session.id, text: "hello" });
        yield* host.sessions.wait(session.id);
        expect((yield* host.sessions.get(session.id)).outcome).toBe("failed");
        expect(yield* llm.requests()).toHaveLength(0);
        expect(
          (yield* host.sessions.messages({ sessionID: session.id, type: "assistant" })).some(
            (message) => message.type === "assistant" && message.error,
          ),
        ).toBe(false);
        yield* Effect.promise(host.disposeOnboarding);
      }),
      databaseFile,
    );
    await reopen(
      (llm) => startTestHost(root, personaDirectory, llm, fakeMessages().messages, hostFile),
      databaseFile,
      sessionID,
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
