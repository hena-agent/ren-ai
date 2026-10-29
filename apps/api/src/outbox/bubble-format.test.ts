import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { expect, test } from "vitest";
import { applicationRpcFixture } from "../../test/application-rpc.test-helper.ts";
import { captureDiagnostics } from "../../test/diagnostics.test-helper.ts";
import { runMessagingTest } from "../../test/messaging.test-helper.ts";
import { applicationRequest } from "../application-request.ts";

test.each(["", " \t\r\n", "가".repeat(121), "😀".repeat(121), "one\n\ntwo", "one\r\n \t\r\ntwo"])(
  "invalid bubble %# returns rewriting instructions through the existing text RPC without sending",
  (text) =>
    runMessagingTest(
      Effect.gen(function* () {
        const f = yield* applicationRpcFixture;
        const result = yield* f.client.send({
          sessionID: f.conversation.sessionID,
          text,
          callID: "rejected",
        });
        expect(result).toContain("not sent:");
        expect(result).toContain("1–120 Unicode characters and no blank lines");
        expect(result).toContain("Nothing was sent");
        expect(result).toContain("call send({ text }) sequentially");
        expect(result).not.toContain("Discard this unsent draft");
        expect(f.messages.bubbles).toEqual([]);
        expect(f.gestures.typing).toEqual([]);
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`SELECT id FROM send`).toEqual([]);
        expect(
          yield* f.client.send({
            sessionID: f.conversation.sessionID,
            text: "짧게 고친 말",
            callID: "rejected",
          }),
        ).toMatch(/^sent \d{2}:\d{2}$/);
        expect(f.messages.bubbles.map((row) => row.text)).toEqual(["짧게 고친 말"]);
      }),
    ),
);

test.each(["가".repeat(120), "😀".repeat(120), "one\nline", "one\r\nline", "  short  "])(
  "valid bubble %# preserves Unicode characters, ordinary line breaks and spacing",
  (text) =>
    runMessagingTest(
      Effect.gen(function* () {
        const f = yield* applicationRpcFixture;
        expect(
          yield* f.client.send({ sessionID: f.conversation.sessionID, text, callID: "valid" }),
        ).toMatch(/^sent \d{2}:\d{2}$/);
        expect(f.messages.bubbles).toEqual([{ handle: f.conversation.handle, text }]);
      }),
    ),
);

test("bubble rejections log safe correlated diagnostics through the real request boundary", async () => {
  const { logs, restore } = captureDiagnostics();
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const f = yield* applicationRpcFixture;
        f.transport.fetch = (request) => applicationRequest(request, f.web.handler);
        const text = "private-message-body\n\nprivate-second-paragraph";
        const result = yield* f.client.send({
          sessionID: f.conversation.sessionID,
          text,
          callID: "private-call",
        });
        const requestId = result.match(/Request ([0-9a-f-]{36})/)![1]!;
        const diagnostics = logs.filter((line) => line.includes('"code":"invalid_bubble"'));
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]).toContain(requestId);
        expect(diagnostics[0]).toContain('"level":"warn"');
        expect(diagnostics[0]).toContain('"stage":"bubble.validate"');
        expect(diagnostics[0]).toContain(`"personaId":"${f.persona.id}"`);
        expect(
          logs.some(
            (line) =>
              line.includes('"operation":"api-app.request"') &&
              line.includes('"outcome":"completed"') &&
              line.includes(requestId),
          ),
        ).toBe(true);
        expect(logs.join("\n")).not.toMatch(
          /private-message|private-second|private-call|application-secret|application@example/,
        );
        expect(f.messages.bubbles).toEqual([]);
        const direct = yield* f.prepared.tools.send(f.conversation.sessionID, text, "direct");
        expect(direct).toContain("Nothing was sent");
      }),
    );
  } finally {
    restore();
  }
});
