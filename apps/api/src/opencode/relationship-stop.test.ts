import { rm } from "node:fs/promises";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { TestLLM } from "@opencode/ai/testing";
import { expect, test } from "vitest";
import { fakeMessages } from "@ren-ai/imsg/testing";
import {
  messagingFixture,
  registration,
  runMessagingTest,
} from "../../test/messaging.test-helper.ts";
import { scriptedPersona, startTestHost } from "../../test/messaging-host.test-helper.ts";

test("relationship ending interrupts a real OpenCode wait and cancels queued inputs without deleting the session", async () => {
  const { root, personaDirectory } = await messagingFixture("relationship-stop-");
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const fake = fakeMessages();
        const llm = yield* scriptedPersona();
        let wait = true;
        yield* llm.serve(() => {
          if (wait) {
            wait = false;
            return TestLLM.tool("relationship-wait", "wait", { seconds: 3300 });
          }
          return TestLLM.text("finished", "answer");
        });
        const host = yield* startTestHost(root, personaDirectory, llm, fake.messages);
        const session = yield* host.createSession("persona1");
        const conversation = yield* host.conversations.create(
          registration("alma@example.com", session.id),
        );
        yield* fake.text(conversation.handle, "hello", Date.now());
        while (
          !JSON.stringify(yield* host.sessions.messages({ sessionID: session.id })).includes(
            '"status":"running"',
          )
        )
          yield* Effect.sleep("10 millis");
        yield* host.sessions.prompt({
          sessionID: session.id,
          text: "queued before termination",
          delivery: "queue",
        });
        yield* host.endingOperations.end(session.id, "여기서 끝낼게요.", "native-stop");
        yield* host.heartbeat.stopped;
        expect((yield* host.sessions.get(session.id)).outcome).toBe("interrupted");
        expect(yield* host.sessions.inbox(session.id)).toEqual([]);
        const sql = yield* SqlClient.SqlClient;
        expect(
          (yield* sql<{
            at: number;
          }>`SELECT stopped_at AS at FROM conversation_end WHERE conversation_id = ${conversation.id}`)[0]!
            .at,
        ).toBeGreaterThan(0);
        const history = yield* host.sessions.messages({ sessionID: session.id });
        yield* fake.text(conversation.handle, "please restart", Date.now());
        yield* host.heartbeat.followUps;
        yield* host.heartbeat.failedTurns;
        expect(yield* host.sessions.messages({ sessionID: session.id })).toEqual(history);
        yield* host.heartbeat.endings;
        expect(fake.bubbles).toHaveLength(2);
      }).pipe(Effect.timeout("15 seconds")),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
