import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanguageModel, LLMClient } from "@opencode/ai";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { OpenAIChat } from "@opencode/ai/protocols";
import { TestLLM } from "@opencode/ai/testing";
import { llmClient } from "@opencode/core/effect/app-node-platform";
import { SessionRunnerModel } from "@opencode/core/session/runner/model";
import { Effect, Fiber, Layer } from "effect";
import { expect, test } from "vitest";
import { startMessagingHost } from "../main.ts";
import { noticeCopy } from "../onboarding/onboarding.ts";
import { fakeGestures } from "../gestures/gestures.fake.ts";
import { fakeMessages } from "../messages/messages.fake.ts";
import { checkedPhone } from "../transcript/transcript.ts";

test("a text admitted during wait wakes the real OpenCode tool for only its Conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-timing-"));
  const personaDirectory = join(root, "content");
  await mkdir(personaDirectory);
  await writeFile(
    join(personaDirectory, "persona1.md"),
    "---\ntime-zone: Pacific/Honolulu\nlanguage: ko\nopening-line: 안녕\nmemory: Remember.\n---\nYou are Persona1.\n",
  );
  const probe = LanguageModel.make({ id: "probe", provider: "test", route: OpenAIChat.route });
  const model = SessionRunnerModel.resolved(probe, {
    capabilities: { input: ["text"], output: ["text"], tools: true },
    cost: [],
    limit: { context: 100_000, output: 1_000 },
  });
  const fake = fakeMessages();
  const cleanup = () => rm(root, { recursive: true, force: true });
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const llm = yield* TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer()));
          let step = 0;
          yield* llm.serve((request) => {
            if (!request.tools.some((tool) => tool.name === "wait"))
              return TestLLM.text("title", "title");
            return step++ === 0
              ? TestLLM.tool("wait-call", "wait", { minutes: 10 })
              : TestLLM.text("done", "answer");
          });
          const host = yield* startMessagingHost(
            join(root, "isolated"),
            {
              configDirectory: join(root, "config"),
              databasePath: ":memory:",
              personaDirectory,
              providers: {},
              model: "test/probe",
              health: { raise: () => Effect.void },
              overrides: [
                llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
                SessionRunnerModel.node.replace(
                  Layer.succeed(SessionRunnerModel.Service, {
                    resolve: () => Effect.succeed(model),
                  }),
                ),
              ],
            },
            fake.messages,
            fakeGestures().gestures,
            { turnstileSecret: "test-secret", notice: noticeCopy },
          );
          const session = yield* host.createSession("persona1");
          const conversation = yield* host.conversations.create({
            handle: "wait@example.com",
            locale: "ko",
            consentVersion: "v1",
            consentLanguage: "ko",
            personaID: "persona1",
            sessionID: session.id,
          });
          const request = yield* Effect.forkScoped(
            Effect.gen(function* () {
              while (
                !JSON.stringify(yield* host.sessions.messages({ sessionID: session.id })).includes(
                  '"status":"running"',
                )
              ) {
                yield* Effect.sleep("20 millis");
              }
              yield* Effect.sleep("50 millis");
              yield* fake.text("wait@example.com", "second", 2000);
            }),
          );
          yield* fake.text("wait@example.com", "first", 1000);
          yield* host.sessions.wait(session.id).pipe(Effect.timeout("3 seconds"));
          yield* Fiber.join(request);
          const turns = JSON.stringify(yield* host.sessions.messages({ sessionID: session.id }));
          expect(turns).toContain("cut short by something new");
          expect(turns).toContain("second");
          expect(turns).toMatch(new RegExp(`msg_checked_${conversation.id}_\\d+`));
          expect(
            [Date.now(), Date.now() - 60_000].some((at) =>
              turns.includes(JSON.stringify(checkedPhone(at, "Pacific/Honolulu")).slice(1, -1)),
            ),
          ).toBe(true);
          const firstRequest = (yield* llm.requests())[0]!;
          expect(JSON.stringify(firstRequest.tools)).toContain("minutes");
          expect(JSON.stringify(firstRequest.tools)).toContain(
            "Pause for up to 12 hours, or until something new arrives",
          );

          step = 0;
          const orphan = yield* host.createSession("persona1");
          yield* host.sessions.prompt({ sessionID: orphan.id, text: "pause" });
          yield* host.sessions.wait(orphan.id).pipe(Effect.timeout("3 seconds"));
          const errors = JSON.stringify(yield* host.sessions.messages({ sessionID: orphan.id }));
          expect(errors.match(/No Conversation for session/g)).toHaveLength(1);
        }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
      ),
    );
  } finally {
    await cleanup();
  }
}, 20000);
