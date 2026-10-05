import { rm } from "node:fs/promises";
import { Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { TestLLM } from "@opencode/ai/testing";
import { expect, test } from "vitest";
import {
  messagingFixture,
  registration,
  runMessagingTest,
} from "../../test/messaging.test-helper.ts";
import { scriptedPersona, startTestHost } from "../../test/messaging-host.test-helper.ts";
import { fakeMessages } from "../messages/messages.fake.ts";
import { remoteHost } from "./remote.ts";
import { exportSessions, restoreSessions } from "./transfer.ts";
import { sessionArchive } from "./transfer-format.ts";

test.each([false, true])(
  "migration keeps completed effects visible before resumed work (queued input: %s)",
  async (queued) => {
    const { root, personaDirectory } = await messagingFixture("transfer-effects-");
    const messages = fakeMessages();
    try {
      await runMessagingTest(
        Effect.gen(function* () {
          const llm = yield* scriptedPersona();
          yield* llm.serve(() =>
            TestLLM.complete(
              { reason: { normalized: "tool-calls" } },
              { type: "text-start", id: "prelude" },
              { type: "text-delta", id: "prelude", text: "First send, then wait." },
              { type: "text-end", id: "prelude" },
              {
                type: "tool-call",
                id: "completed-send",
                name: "send",
                input: { text: "one-time bubble" },
              },
              { type: "tool-call", id: "blocked-wait", name: "wait", input: { minutes: 55 } },
            ),
          );
          const source = yield* startTestHost(root, personaDirectory, llm, messages.messages);
          yield* Effect.addFinalizer(() => Effect.promise(source.disposeOnboarding));
          const remote = yield* remoteHost(
            {
              baseUrl: "https://oc.test",
              authorization: "Basic test",
              directory: personaDirectory,
              model: "test/probe",
            },
            source.personas,
          ).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
              source.web(new Request(input, init)),
            ),
          );
          const session = yield* source.createSession("persona1");
          yield* source.conversations.create(registration("once@example.com", session.id));
          yield* source.sessions.prompt({ sessionID: session.id, text: "perform the two actions" });
          yield* Effect.gen(function* () {
            for (;;) {
              const [current] = yield* remote.sessions.messages({
                sessionID: session.id,
                type: "assistant",
                limit: 1,
              });
              if (
                current?.type === "assistant" &&
                !current.time.completed &&
                current.content.some(
                  (part) =>
                    part.type === "tool" &&
                    part.id === "completed-send" &&
                    part.state.status === "completed",
                )
              )
                return;
              yield* Effect.sleep("10 millis");
            }
          }).pipe(Effect.timeout("5 seconds"));
          expect(messages.bubbles).toEqual([
            { handle: "once@example.com", text: "one-time bubble" },
          ]);
          if (queued)
            yield* remote.sessions.prompt({
              sessionID: session.id,
              text: "queued request",
              delivery: "queue",
              resume: false,
            });
          const contents = yield* exportSessions(remote.client, [session.id]);
          expect(
            Schema.decodeUnknownSync(sessionArchive)(contents).sessions[0]?.recovery?.tools,
          ).toMatchObject([
            {
              callID: "completed-send",
              tool: "send",
              state: {
                status: "completed",
                input: { text: "one-time bubble" },
                content: [{ type: "text", text: "sent" }],
              },
            },
            {
              callID: "blocked-wait",
              tool: "wait",
              state: { status: "running", input: { minutes: 55 } },
            },
          ]);
          yield* remote.sessions.interrupt(session.id);
          yield* remote.sessions.wait(session.id);
          yield* remote.sessions.remove(session.id);
          yield* restoreSessions(remote.client, contents, personaDirectory);
          const restoredInbox = yield* remote.sessions.inbox(session.id);
          expect(restoredInbox.map((item) => item.type)).toEqual([queued ? "user" : "synthetic"]);
          const journal = yield* remote.sessions.messages({
            sessionID: session.id,
            type: "synthetic",
          });
          expect(journal).toHaveLength(1);
          expect(JSON.stringify(journal)).toContain("completed-send");
          expect(JSON.stringify(journal)).not.toContain("First send, then wait.");
          let repeated = false;
          yield* llm.serve((request) => {
            const history = request.messages
              .flatMap((message) => message.content)
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
            if (
              history.includes("completed-send") &&
              history.includes("one-time bubble") &&
              history.includes('"status":"completed"')
            )
              return TestLLM.text("already completed; do not resend", "answer");
            if (!repeated) {
              repeated = true;
              return TestLLM.tool("new-recovery-call", "send", { text: "one-time bubble" });
            }
            return TestLLM.text("duplicated", "answer");
          });
          yield* remote.retry(session.id);
          yield* remote.sessions.wait(session.id).pipe(Effect.timeout("5 seconds"));
          expect(messages.bubbles).toHaveLength(1);
          expect(
            JSON.stringify(yield* remote.sessions.messages({ sessionID: session.id })),
          ).toContain("already completed; do not resend");
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
