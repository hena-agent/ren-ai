import { rm } from "node:fs/promises";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { fakeMessages } from "@ren-ai/imsg/testing";
import {
  messagingFixture,
  registration,
  runMessagingTest,
} from "../../test/messaging.test-helper.ts";
import {
  providerUnavailable,
  scriptedPersona,
  startTestHost,
} from "../../test/messaging-host.test-helper.ts";

test("operator removal retains a test session but forgets its durable failed-turn deadline", async () => {
  const { root, personaDirectory } = await messagingFixture("failed-retention-");
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const llm = yield* scriptedPersona();
        yield* llm.serve(() => providerUnavailable("Unavailable"));
        const host = yield* startTestHost(root, personaDirectory, llm, fakeMessages().messages);
        const session = yield* host.createSession("persona1");
        const handle = "retained@example.com";
        yield* host.operator.testHandle(handle, true);
        yield* host.conversations.create(registration(handle, session.id));
        yield* host.sessions.prompt({ sessionID: session.id, text: "failed before removal" });
        yield* host.sessions.wait(session.id);
        yield* host.heartbeat.failedTurns;
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`SELECT * FROM failed_turn`).toHaveLength(1);
        expect(yield* host.operator.remove(handle)).toBe("removed");
        expect(yield* sql`SELECT * FROM failed_turn`).toEqual([]);
        expect(yield* host.conversations.bySession(session.id)).toBeUndefined();
        expect((yield* host.sessions.get(session.id)).title).toContain("removed");
        yield* TestClock.adjust("2 seconds");
        yield* host.heartbeat.failedTurns;
        expect(yield* llm.requests()).toHaveLength(1);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
