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

test("the unchanged text-based plugin can rewrite a rejected paragraph and send short bubbles with a wait", async () => {
  const { root, personaDirectory } = await messagingFixture("short-bubbles-");
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const fake = fakeMessages();
        const llm = yield* scriptedPersona();
        const first = "기다리고 있었어. 잘 도착했네.";
        const second = "이제 씻고 푹 자. 내일 연락할게.";
        let step = 0;
        yield* llm.serve((request) => {
          const send = request.tools.find((tool) => tool.name === "send");
          if (!send) return TestLLM.text("title", "title");
          expect("inputSchema" in send && send.inputSchema).toMatchObject({
            required: ["text"],
            properties: { text: { type: "string" } },
          });
          switch (step++) {
            case 0:
              return TestLLM.tool("read-first", "read", {});
            case 1:
              return TestLLM.tool("too-many-paragraphs", "send", { text: `${first}\n\n${second}` });
            case 2:
              expect(fake.bubbles).toEqual([]);
              expect(JSON.stringify(request.messages)).toContain("Nothing was sent");
              expect(JSON.stringify(request.messages)).toContain("120");
              return TestLLM.tool("first-bubble", "send", { text: first });
            case 3:
              return TestLLM.tool("short-pause", "wait", { seconds: 0.01 });
            case 4:
              expect(fake.bubbles.map((row) => row.text)).toEqual([first]);
              expect(JSON.stringify(request.messages)).toContain("paused");
              return TestLLM.tool("second-bubble", "send", { text: second });
            default:
              return TestLLM.text("done", "answer");
          }
        });
        const host = yield* startTestHost(root, personaDirectory, llm, fake.messages);
        const session = yield* host.createSession("persona1");
        const handle = "short-bubbles@example.com";
        yield* host.conversations.create(registration(handle, session.id));
        yield* fake.text(handle, "도착했어", Date.now());
        yield* host.sessions.wait(session.id).pipe(Effect.timeout("15 seconds"));
        expect(fake.bubbles).toEqual([
          { handle, text: first },
          { handle, text: second },
        ]);
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`SELECT tool_call_id AS callID FROM send ORDER BY id`).toEqual([
          { callID: "first-bubble" },
          { callID: "second-bubble" },
        ]);
        expect(
          JSON.stringify(yield* host.sessions.messages({ sessionID: session.id })),
        ).not.toContain("Missing key");
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
