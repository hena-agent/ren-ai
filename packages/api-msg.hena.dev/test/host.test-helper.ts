import { LanguageModel, LLMClient, type Message } from "@opencode/ai";
import { OpenAIChat } from "@opencode/ai/protocols";
import { TestLLM } from "@opencode/ai/testing";
import { llmClient } from "@opencode/core/effect/app-node-platform";
import { SessionRunnerModel } from "@opencode/core/session/runner/model";
import { Agent, AbsolutePath, Location } from "@opencode/schema";
import { Plugin } from "@opencode/plugin/effect";
import { Effect, Layer, Schema } from "effect";
import { expect } from "vitest";
import { join } from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { startMessagingHost } from "./application.test-helper.ts";
import type { Messages } from "../src/messages/messages.ts";
import type { Gestures } from "../src/gestures/gestures.ts";
import { noticeCopy } from "../src/onboarding/onboarding.ts";
import { silentAlerts } from "../src/opencode/scripted-overrides.test-helper.ts";

export const expectLateResults = (messages: ReadonlyArray<Message>) => {
  const parts = messages.flatMap((entry) => entry.content);
  const results = parts.filter((part) => part.type === "tool-result");
  expect(results.filter((part) => part.id === "call-1").map((part) => part.result)).toEqual([
    { type: "text", value: "delivered 01:48 (confirmed late)" },
  ]);
  expect(results.filter((part) => part.id === "call-2").map((part) => part.result)).toEqual([
    { type: "text", value: "not sent: earlier send did not go out" },
  ]);
  expect(parts.filter((part) => part.type === "tool-call").map((part) => part.id)).toEqual([
    "call-1",
    "call-2",
    "pause",
  ]);
};

export const valid = `---
time-zone: Asia/Seoul
language: ko
opening-line: 번호 받았으니까 먼저 연락해 봐
memory: Remember his name.
---
You are Persona1. Speak Korean.
`;

export const model = SessionRunnerModel.resolved(
  LanguageModel.make({ id: "probe", provider: "test", route: OpenAIChat.route }),
  {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    limit: { context: 100_000, output: 1_000 },
  },
);

export const scriptedOverrides = (llm: TestLLM.TestInterface) => [
  llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
  SessionRunnerModel.node.replace(
    Layer.succeed(SessionRunnerModel.Service, { resolve: () => Effect.succeed(model) }),
  ),
];

export const startScriptedMessagingHost = (
  root: string,
  personaDirectory: string,
  llm: TestLLM.TestInterface,
  messages: Messages,
  gestures: Gestures,
  withImages = false,
) =>
  startMessagingHost(
    join(root, "isolated"),
    {
      configDirectory: join(root, "config"),
      databasePath: ":memory:",
      personaDirectory,
      providers: {},
      model: "test/probe",
      health: { raise: () => Effect.void },
      overrides: withImages
        ? [
            ...scriptedOverrides(llm),
            SessionRunnerModel.node.replace(
              Layer.succeed(SessionRunnerModel.Service, {
                resolve: () =>
                  Effect.succeed(
                    SessionRunnerModel.resolved(
                      LanguageModel.make({
                        id: "probe",
                        provider: "test",
                        route: OpenAIChat.route,
                      }),
                      {
                        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
                        cost: [],
                        limit: { context: 100_000, output: 1_000 },
                      },
                    ),
                  ),
              }),
            ),
          ]
        : scriptedOverrides(llm),
    },
    messages,
    gestures,
    { turnstileSecret: "test-secret", notice: noticeCopy },
    silentAlerts,
  );

export const bindConversation = (
  host: Effect.Success<ReturnType<typeof startMessagingHost>>,
  handle: string,
  sessionID: string,
) =>
  host.conversations.create({
    handle,
    locale: "ko",
    consentVersion: "v1",
    consentLanguage: "ko",
    personaID: "persona1",
    sessionID,
  });

export const disabledIDs = [
  "opencode.config.instruction",
  "opencode.config.compatibility",
  "opencode.provider.ollama",
  "opencode.provider.lmstudio",
  "opencode.provider.vllm",
];

export const intruder = Plugin.define({
  id: "untrusted-tool",
  effect: (ctx) =>
    ctx.tool
      .transform((editor) =>
        editor.add({
          name: "intruder",
          description: "Must be filtered",
          input: Schema.Struct({}),
          output: Schema.String,
          options: { codemode: false },
          execute: () => Effect.succeed({ output: "bad" }),
        }),
      )
      .pipe(Effect.asVoid),
});

export const personaFixture = async (prefix: string, content: string) => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const personaDirectory = join(root, "content");
  await mkdir(personaDirectory);
  await writeFile(join(personaDirectory, "persona1.md"), content);
  return { root, personaDirectory, cleanup: () => rm(root, { recursive: true, force: true }) };
};

export const unrestricted = (directory: string) => ({
  agent: Agent.ID.make("persona1"),
  model: model.ref,
  location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
  permissions: [{ action: "*", resource: "*", effect: "allow" as const }],
});
