import { LanguageModel, LLMClient } from "@opencode/ai";
import { OpenAIChat } from "@opencode/ai/protocols";
import { TestLLM } from "@opencode/ai/testing";
import { llmClient } from "@opencode/core/effect/app-node-platform";
import { SessionRunnerModel } from "@opencode/core/session/runner/model";
import { Agent, AbsolutePath, Location } from "@opencode/schema";
import { Plugin } from "@opencode/plugin/effect";
import { Effect, Layer, Schema } from "effect";

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

export const unrestricted = (directory: string) => ({
  agent: Agent.ID.make("persona1"),
  model: model.ref,
  location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
  permissions: [{ action: "*", resource: "*", effect: "allow" as const }],
});
