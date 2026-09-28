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
import { Session } from "@opencode/schema/session";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { fakeMessages } from "../messages/messages.fake.ts";

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
        yield* Effect.promise(host.disposeOnboarding);
      }),
      databaseFile,
    );
    await runMessagingTest(
      Effect.gen(function* () {
        const llm = yield* scriptedPersona();
        yield* llm.serve(() => TestLLM.text("recovered", "answer"));
        const host = yield* open(llm);
        expect((yield* host.conversations.byHandle("restart@example.com"))?.sessionID).toBe(
          sessionID,
        );
        yield* host.sessions.wait(Session.ID.make(sessionID)).pipe(Effect.timeout("20 seconds"));
        expect((yield* host.sessions.get(Session.ID.make(sessionID))).outcome).toBe("succeeded");
        expect(JSON.stringify(yield* llm.requests())).toContain("persisted failure");
        yield* Effect.promise(host.disposeOnboarding);
      }),
      databaseFile,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
