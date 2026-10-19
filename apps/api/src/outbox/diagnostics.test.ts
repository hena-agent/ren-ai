import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { captureDiagnostics } from "../../test/diagnostics.test-helper.ts";
import { applicationRpcFixture } from "../../test/application-rpc.test-helper.ts";
import { runMessagingTest } from "../../test/messaging.test-helper.ts";

const fail = () =>
  Effect.fail(
    new Error("private text application-secret", {
      cause: Object.assign(new Error("private upstream"), { code: "ECONNRESET" }),
    }),
  );

test("submission and resolution failures preserve correlation, uncertainty and private-data exclusion through RPC", async () => {
  const { logs, restore } = captureDiagnostics();
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const f = yield* applicationRpcFixture;
        const requestId = crypto.randomUUID();
        f.transport.fetch = (request) => {
          request.headers.set("x-operation-id", requestId);
          return f.web.handler(request);
        };
        f.messages.messages.sendText = fail;
        f.messages.messages.resolveSend = fail;
        const send = (callID: string) =>
          f.client.send({ sessionID: f.conversation.sessionID, callID, text: "private text" });
        expect(yield* send("private-first")).toBe("not sent: send in doubt");
        expect(String(yield* send("private-second").pipe(Effect.flip))).toContain(requestId);
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`SELECT state FROM send`).toEqual([{ state: "uncertain" }]);
        expect(f.messages.bubbles).toEqual([]);
        const failures = logs.filter((line) => line.includes('"outcome":"failed"'));
        expect(failures).toHaveLength(2);
        for (const stage of ["transport.submit", "transport.resolve"]) {
          const entry = failures.find((line) => line.includes(stage))!;
          expect(entry).toContain(requestId);
          expect(entry).toContain("ECONNRESET");
          expect(entry).toContain('"operationId":');
        }
        for (const sensitive of [
          f.conversation.handle,
          "private text",
          "private upstream",
          "application-secret",
          "private-first",
          "private-second",
        ])
          expect(logs.join("\n")).not.toContain(sensitive);
      }),
    );
  } finally {
    restore();
  }
});
