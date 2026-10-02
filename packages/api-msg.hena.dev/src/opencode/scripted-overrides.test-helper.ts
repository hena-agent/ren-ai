import { LLMClient } from "@opencode/ai";
import { TestLLM } from "@opencode/ai/testing";
import { llmClient } from "@opencode/core/effect/app-node-platform";
import { SessionRunnerModel } from "@opencode/core/session/runner/model";
import { Effect, Layer } from "effect";
export const scriptedOverrides = (
  llm: TestLLM.TestInterface,
  model: ReturnType<typeof SessionRunnerModel.resolved>,
) => [
  llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
  SessionRunnerModel.node.replace(
    Layer.succeed(SessionRunnerModel.Service, { resolve: () => Effect.succeed(model) }),
  ),
];
