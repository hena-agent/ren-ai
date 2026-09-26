import * as filesystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ai from "@opencode/ai";
import { OpenAIChat } from "@opencode/ai/protocols";
import { TestLLM } from "@opencode/ai/testing";
import { llmClient as replaceClient } from "@opencode/core/effect/app-node-platform";
import { SessionRunnerModel } from "@opencode/core/session/runner/model";
import { SessionMessage } from "@opencode/schema/session-message";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { startMessagingHost } from "../main.ts";
import { silentAlerts } from "./scripted-overrides.test-helper.ts";
import { fakeMessages } from "../messages/messages.fake.ts";
import { fakeGestures } from "../gestures/gestures.fake.ts";
import { noticeCopy } from "../onboarding/onboarding.ts";

test("a real persona session reads and reacts only to its own User's latest message", async () => {
  const root = await filesystem.mkdtemp(join(tmpdir(), "reading-persona-"));
  const personaDirectory = join(root, "persona");
  await filesystem.mkdir(personaDirectory);
  await filesystem.writeFile(
    join(personaDirectory, "persona1.md"),
    `---
time-zone: Asia/Seoul
language: ko
opening-line: Hello
memory: Remember him.
---
You are Persona1.
`,
  );
  const imessage = fakeMessages();
  const ui = fakeGestures();
  let reacted = false;
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const llm = yield* Effect.provide(TestLLM.Test, TestLLM.testLayer());
          const capabilities = { tools: true, input: ["text"], output: ["text"] } as const;
          const model = SessionRunnerModel.resolved(
            ai.LanguageModel.make({ id: "reading", provider: "test", route: OpenAIChat.route }),
            {
              capabilities,
              cost: [],
              limit: { context: 100_000, output: 1_000 },
            },
          );
          let step = 0;
          yield* llm.serve((request) => {
            if (!request.tools.some((tool) => tool.name === "react"))
              return TestLLM.text("title", "title");
            step++;
            if (step === 1) return TestLLM.tool("reading", "read", {});
            if (step === 2) return TestLLM.tool("reacting", "react", { tapback: "love" });
            if (step === 3) return TestLLM.tool("read-error", "read", {});
            if (step === 4) return TestLLM.tool("react-error", "react", { tapback: "question" });
            if (step === 5) return TestLLM.tool("invalid", "react", { tapback: "party" });
            return TestLLM.text("done", "answer");
          });
          const host = yield* startMessagingHost(
            join(root, "isolated"),
            {
              configDirectory: join(root, "private"),
              databasePath: ":memory:",
              personaDirectory,
              providers: {},
              model: "test/reading",
              health: { raise: () => Effect.void },
              overrides: [
                replaceClient.replace(Layer.succeed(ai.LLMClient.Service, llm)),
                SessionRunnerModel.node.replace(
                  Layer.succeed(SessionRunnerModel.Service, {
                    resolve: () => Effect.succeed(model),
                  }),
                ),
              ],
            },
            {
              ...imessage.messages,
              after: (id) =>
                reacted ? Effect.fail(new Error("imsg unavailable")) : imessage.messages.after(id),
            },
            {
              ...ui.gestures,
              read: (handle) =>
                reacted ? Effect.fail(new Error("UI unavailable")) : ui.gestures.read(handle),
              react: (handle, tapback) =>
                ui.gestures.react(handle, tapback).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      reacted = true;
                    }),
                  ),
                ),
            },
            { turnstileSecret: "test-secret", notice: noticeCopy },
            silentAlerts,
          );
          const session = yield* host.createSession("persona1");
          const conversation = yield* host.conversations.create({
            handle: "person@example.com",
            locale: "ko",
            consentVersion: "v1",
            consentLanguage: "ko",
            personaID: "persona1",
            sessionID: session.id,
          });
          expect(session.permissions?.map((rule) => rule.action)).toEqual([
            "*",
            "send",
            "wait",
            "read",
            "react",
          ]);
          const row = yield* imessage.text(conversation.handle, "hey", Date.now());
          yield* host.sessions.wait(session.id).pipe(Effect.timeout("20 seconds"));
          expect(ui.reads).toEqual([conversation.handle]);
          expect(ui.reactions).toEqual([{ handle: conversation.handle, tapback: "love" }]);
          const recorded = yield* sql<{
            kind: string;
            content: string;
            state: string;
            target_guid: string;
          }>`SELECT kind, content, state, target_guid FROM send`;
          expect(recorded).toEqual([
            { kind: "tapback", content: "love", state: "sent", target_guid: row.guid },
          ]);
          expect(
            JSON.stringify(yield* host.sessions.messages({ sessionID: session.id })),
          ).toContain("reacted love");
          expect(
            JSON.stringify(yield* host.sessions.messages({ sessionID: session.id })),
          ).toContain('"text":"read"');
          expect(
            JSON.stringify(yield* host.sessions.messages({ sessionID: session.id })),
          ).toContain("not read: UI unavailable");
          expect(
            JSON.stringify(yield* host.sessions.messages({ sessionID: session.id })),
          ).toContain("imsg unavailable");
          expect(
            (yield* llm.requests()).every((request) =>
              request.tools.every((tool) => ["send", "wait", "read", "react"].includes(tool.name)),
            ),
          ).toBe(true);
          const tools = (yield* llm.requests())[0]!.tools;
          expect(tools.find((tool) => tool.name === "read")?.description).toBe(
            "Mark this Conversation's messages read now",
          );
          expect(tools.find((tool) => tool.name === "react")?.description).toBe(
            "React to his latest message with a standard tapback",
          );
          expect(JSON.stringify(tools.find((tool) => tool.name === "react"))).toContain(
            '"question"',
          );
          const orphan = yield* host.createSession("persona1");
          step = 0;
          yield* host.sessions.prompt({
            sessionID: orphan.id,
            id: SessionMessage.ID.make("msg_orphan_read"),
            text: "hi",
          });
          yield* host.sessions.wait(orphan.id).pipe(Effect.timeout("20 seconds"));
          expect(JSON.stringify(yield* host.sessions.messages({ sessionID: orphan.id }))).toContain(
            "No Conversation for session",
          );
          expect(JSON.stringify(yield* host.sessions.messages({ sessionID: orphan.id }))).toContain(
            "not reacted: no Conversation for session",
          );
          expect(ui.reads).toHaveLength(1);
          expect(ui.reactions).toHaveLength(1);
        }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
      ),
    );
  } finally {
    await filesystem.rm(root, { recursive: true, force: true });
  }
}, 60000);
