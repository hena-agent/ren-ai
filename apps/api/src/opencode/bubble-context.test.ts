import { rm } from "node:fs/promises";
import { TestLLM } from "@opencode/ai/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { fakeMessages } from "@ren-ai/imsg/testing";
import { scriptedPersona, startTestHost } from "../../test/messaging-host.test-helper.ts";
import {
  messagingFixture,
  registration,
  runMessagingTest,
} from "../../test/messaging.test-helper.ts";

test("late confirmations preserve individual bubble identities and do not label tapbacks as bubbles", async () => {
  const { root, personaDirectory } = await messagingFixture("bubble-context-");
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const fake = fakeMessages();
        const llm = yield* scriptedPersona();
        let step = 0;
        yield* llm.serve((request) => {
          if (!request.tools.some((tool) => tool.name === "send"))
            return TestLLM.text("title", "title");
          if (step++ === 0) return TestLLM.tool("reaction", "react", { tapback: "love" });
          if (step === 2)
            return TestLLM.tool("reply", "send", {
              messages: [{ text: "먼저 반응" }, { text: "덧붙임", delaySeconds: 0 }],
            });
          return TestLLM.text("done", "answer");
        });
        const host = yield* startTestHost(root, personaDirectory, llm, fake.messages);
        const session = yield* host.createSession("persona1");
        const handle = "bubble-context@example.com";
        yield* host.conversations.create(registration(handle, session.id));
        yield* fake.text(handle, "안녕", Date.now());
        yield* host.sessions.wait(session.id).pipe(Effect.timeout("10 seconds"));
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`SELECT kind FROM send ORDER BY id`).toEqual([
          { kind: "tapback" },
          { kind: "text" },
          { kind: "text" },
        ]);
        yield* sql`UPDATE send SET late = 1, state = CASE WHEN kind = 'tapback' THEN 'failed' ELSE 'delivered' END`;
        yield* sql`INSERT INTO send (handle, conversation_id, kind, content, state, recorded_at, updated_at, late)
        SELECT handle, conversation_id, 'text', 'unbound outcome', 'failed', recorded_at, updated_at, 1 FROM send LIMIT 1`;
        yield* host.sessions.prompt({ sessionID: session.id, text: "check confirmed outcomes" });
        yield* host.sessions.wait(session.id).pipe(Effect.timeout("10 seconds"));
        const results = (yield* llm.requests())
          .at(-1)!
          .messages.flatMap((entry) => entry.content)
          .filter((part) => part.type === "tool-result");
        const reply = JSON.stringify(results.find((part) => part.id === "reply"));
        expect(reply).toContain("Bubble 1: delivered");
        expect(reply).toContain("Bubble 2: delivered");
        expect(reply).toContain("confirmed late");
        expect(reply).toContain("Bubble 1: sent");
        expect(reply).toContain("Updated outcomes");
        const reaction = JSON.stringify(results.find((part) => part.id === "reaction"));
        expect(reaction).toContain("earlier send did not go out");
        expect(reaction).not.toContain("Bubble 1:");
        expect(reply + reaction).not.toContain("unbound outcome");
        expect(fake.bubbles.map((row) => row.text)).toEqual(["먼저 반응", "덧붙임"]);
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
