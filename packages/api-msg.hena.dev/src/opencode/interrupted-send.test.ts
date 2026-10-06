import { rm } from "node:fs/promises";
import {
  messagingFixture,
  registration,
  runMessagingTest,
} from "../../test/messaging.test-helper.ts";
import { scriptedPersona, startTestHost } from "../../test/messaging-host.test-helper.ts";
import { TestLLM } from "@opencode/ai/testing";
import { Deferred, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { fakeMessages } from "../messages/messages.fake.ts";

test("an interrupted send is shown to her with its real outcome after Messages settles it", async () => {
  const { root, personaDirectory } = await messagingFixture("interrupted-send-");
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const never = yield* Deferred.make<void>();
        const fake = fakeMessages();
        const llm = yield* scriptedPersona();
        yield* llm.serve((request) =>
          request.messages.some((message) => JSON.stringify(message).includes("check outcome"))
            ? TestLLM.text("understood", "answer")
            : TestLLM.tool("interrupted-call", "send", { text: "hello" }),
        );
        const host = yield* startTestHost(root, personaDirectory, llm, {
          ...fake.messages,
          sendText: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(never)),
              Effect.as({ guid: "never" }),
            ),
        });
        const session = yield* host.createSession("persona1");
        const handle = "interrupted@example.com";
        yield* host.conversations.create(registration(handle, session.id));
        yield* host.sessions.prompt({ sessionID: session.id, text: "send now" });
        yield* Deferred.await(entered).pipe(Effect.timeout("20 seconds"));
        yield* host.sessions.interrupt(session.id);
        yield* host.sessions.wait(session.id);
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`SELECT state FROM send WHERE tool_call_id = 'interrupted-call'`).toEqual([
          { state: "recorded" },
        ]);
        expect(JSON.stringify(yield* host.sessions.messages({ sessionID: session.id }))).toContain(
          "Tool execution interrupted",
        );
        yield* fake.outgoing(handle, "hello", Date.now() + 1, "delivered");
        yield* host.sessions.prompt({ sessionID: session.id, text: "check outcome" });
        yield* host.sessions.wait(session.id).pipe(Effect.timeout("20 seconds"));
        const request = JSON.stringify((yield* llm.requests()).at(-1)?.messages);
        expect(request).toContain("delivered");
        expect(request).toContain("confirmed late");
        expect(request).not.toContain("Tool execution interrupted");
        yield* Effect.promise(host.disposeOnboarding);
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
