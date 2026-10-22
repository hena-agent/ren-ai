import { rm } from "node:fs/promises";
import { TestLLM } from "@opencode/ai/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { fakeMessages } from "@ren-ai/imsg/testing";
import {
  messagingFixture,
  registration,
  runMessagingTest,
} from "../../test/messaging.test-helper.ts";
import { scriptedPersona, startTestHost } from "../../test/messaging-host.test-helper.ts";

test("real model requests receive their own starting relationship on every turn, independent of history", async () => {
  const { root, personaDirectory } = await messagingFixture("starting-relationship-");
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const llm = yield* scriptedPersona();
        yield* llm.serve((request) =>
          request.tools.some((tool) => tool.name === "send")
            ? TestLLM.text("반가워!", "answer")
            : TestLLM.text("title", "title"),
        );
        const host = yield* startTestHost(root, personaDirectory, llm, fakeMessages().messages);
        const sql = yield* SqlClient.SqlClient;
        const friend = yield* host.createSession("persona1");
        yield* host.conversations.create(registration("friend@example.com", friend.id));
        yield* sql`UPDATE conversation SET starting_relationship = 'friends' WHERE session_id = ${friend.id}`;
        for (const text of ["안녕", "오늘은 좀 덥다"]) {
          yield* host.sessions.prompt({ sessionID: friend.id, text });
          yield* host.sessions.wait(friend.id);
          const request = (yield* llm.requests()).at(-1)!;
          expect(JSON.stringify(request.system)).toContain(
            "<starting-relationship>friends</starting-relationship>",
          );
          expect(JSON.stringify(request.system)).toContain("자동으로 썸이나 연인이 되지 않는다");
          expect(JSON.stringify(request.system)).toContain(
            "가상의 고백·데이트·기념일·공동 추억을 만들지 않는다",
          );
        }
        const partner = yield* host.createSession("persona1");
        yield* host.conversations.create(registration("partner@example.com", partner.id));
        yield* sql`UPDATE conversation SET starting_relationship = 'dating' WHERE session_id = ${partner.id}`;
        yield* host.sessions.prompt({ sessionID: partner.id, text: "처음 인사해" });
        yield* host.sessions.wait(partner.id);
        const other = JSON.stringify((yield* llm.requests()).at(-1)!.system);
        expect(other).toContain("<starting-relationship>dating</starting-relationship>");
        expect(other).not.toContain("<starting-relationship>friends</starting-relationship>");
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
