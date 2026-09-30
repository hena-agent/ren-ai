import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestLLM } from "@opencode/ai/testing";
import { AIError, AuthenticationError } from "@opencode/ai/schema/errors";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, type Scope } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { scriptedOverrides } from "./host.test-helper.ts";
import { startMessagingHost, startPersonaHost } from "./application.test-helper.ts";
import type { FailureAlerts } from "../src/opencode/failed-turns.ts";
import type { Messages } from "../src/messages/messages.ts";
import { fakeGestures } from "../src/gestures/gestures.fake.ts";
import { noticeCopy } from "../src/onboarding/onboarding.ts";
import { silentAlerts } from "../src/opencode/scripted-overrides.test-helper.ts";

export const messagingFixture = async (prefix: string, opening = "Hi") => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const personaDirectory = join(root, "content");
  await mkdir(personaDirectory);
  await writeFile(
    join(personaDirectory, "persona1.md"),
    `---\ntime-zone: Asia/Seoul\nlanguage: ko\nopening-line: ${opening}\nmemory: Remember.\n---\nYou are Persona1.\n`,
  );
  return { root, personaDirectory };
};

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

export const registration = (handle: string, sessionID: string) => ({
  handle,
  locale: "ko",
  consentVersion: "v1",
  consentLanguage: "ko",
  personaID: "persona1",
  sessionID,
});

export const runMessagingTest = <A, E>(
  body: Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>,
  filename = ":memory:",
) => Effect.runPromise(Effect.scoped(body.pipe(Effect.provide(SqliteClient.layer({ filename })))));

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
