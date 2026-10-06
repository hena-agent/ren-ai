import { join } from "node:path";
import { TestLLM } from "@opencode/ai/testing";
import { AIError, AuthenticationError } from "@opencode/ai/schema/errors";
import { Effect } from "effect";
import { scriptedOverrides } from "./host.test-helper.ts";
import { startMessagingHost, startPersonaHost } from "./application.test-helper.ts";
import type { FailureAlerts } from "../src/opencode/failed-turns.ts";
import type { Messages } from "../src/messages/messages.ts";
import { fakeGestures } from "../src/gestures/gestures.fake.ts";
import { noticeCopy } from "../src/onboarding/onboarding.ts";
import { silentAlerts } from "./messaging.test-helper.ts";

const messagingOptions = (
  root: string,
  personaDirectory: string,
  llm: TestLLM.TestInterface,
  databasePath = ":memory:",
) => ({
  configDirectory: join(root, "config"),
  databasePath,
  personaDirectory,
  providers: {},
  model: "test/probe",
  overrides: scriptedOverrides(llm),
  health: { raise: () => Effect.void },
});

export const scriptedPersona = () => TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer()));

export const standaloneTestHost = (
  root: string,
  personaDirectory: string,
  llm: TestLLM.TestInterface,
) =>
  startPersonaHost(join(root, "isolated"), {
    ...messagingOptions(root, personaDirectory, llm),
    handleForSession: () => Effect.succeed(undefined),
  });

export const ordinaryProjectHost = (root: string, personaDirectory: string) =>
  Effect.gen(function* () {
    const llm = yield* scriptedPersona();
    yield* llm.serve(() => TestLLM.text("ordinary project", "answer"));
    const native = yield* standaloneTestHost(root, personaDirectory, llm);
    return { native, llm };
  });

export const providerUnavailable = (message: string) =>
  TestLLM.failAfter(new AIError({ reason: new AuthenticationError({ message }) }));

export const startTestHost = (
  root: string,
  personaDirectory: string,
  llm: TestLLM.TestInterface,
  messages: Messages,
  databasePath = ":memory:",
  alerts: FailureAlerts = silentAlerts,
) =>
  startMessagingHost(
    join(root, "isolated"),
    messagingOptions(root, personaDirectory, llm, databasePath),
    messages,
    fakeGestures().gestures,
    { turnstileSecret: "test", notice: noticeCopy },
    alerts,
  );

export const quietTestHost = (
  root: string,
  personaDirectory: string,
  messages: Messages,
  databasePath = ":memory:",
) =>
  Effect.gen(function* () {
    const llm = yield* scriptedPersona();
    yield* llm.serve(() => TestLLM.text("quiet", "answer"));
    return yield* startTestHost(root, personaDirectory, llm, messages, databasePath);
  });
