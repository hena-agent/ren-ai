import { rm } from "node:fs/promises";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { fakeMessages } from "@ren-ai/imsg/testing";
import { personaMemory, readRuntime } from "@ren-ai/plugin-session-folder/memory";
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

test("removal completes without accounting metadata and preserves the persona's life", async () => {
  const fixture = await messagingFixture("removal-without-accounting-");
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const host = yield* startTestHost(
          fixture.root,
          fixture.personaDirectory,
          yield* scriptedPersona(),
          fakeMessages().messages,
        );
        const session = yield* host.createSession("persona1");
        const relationship = yield* host.conversations.create(
          registration("missing-accounting@example.com", session.id),
        );
        const memory = personaMemory(session.location.directory, session.id);
        yield* Effect.promise(() => memory.context());
        yield* Effect.promise(() =>
          memory.run(
            "update_memory",
            {
              scope: "life",
              markdown: "An unfinished painting",
              reason: "Own plans",
            },
            "own-plan",
            "own-plan",
          ),
        );
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM usage_session WHERE session_id = ${session.id}`;
        expect(yield* host.operator.remove(relationship.handle)).toBe("removed");
        expect(yield* host.sessions.get(session.id).pipe(Effect.flip)).toBeInstanceOf(Error);
        expect(yield* host.conversations.byHandle(relationship.handle)).toBeUndefined();
        expect(
          (yield* Effect.promise(() => readRuntime(session.location.directory)))?.shortTerm,
        ).toBe("An unfinished painting");
      }),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

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
