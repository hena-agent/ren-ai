import { rm } from "node:fs/promises";
import { ConfigProvider, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { captureDiagnostics } from "../../test/diagnostics.test-helper.ts";
import { fakeGestures, fakeMessages } from "@ren-ai/imsg/testing";
import {
  messagingFixture,
  registration,
  runMessagingTest,
} from "../../test/messaging.test-helper.ts";
import { quietTestHost } from "../../test/messaging-host.test-helper.ts";
import { serveTestOperator } from "../../test/operator-http.test-helper.ts";
import { operatorHandler } from "./api.ts";
import { runOperatorCli } from "./cli.ts";
import { outbox } from "../outbox/outbox.ts";
import { applicationRequest } from "../application-request.ts";

test("the authenticated CLI releases only the reviewed legacy call, preserves the Conversation, and is idempotent", async () => {
  const { root, personaDirectory } = await messagingFixture("release-send-");
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const fake = fakeMessages();
        const host = yield* quietTestHost(root, personaDirectory, fake.messages);
        const sql = yield* SqlClient.SqlClient;
        const session = yield* host.createSession("persona1");
        const conversation = yield* host.conversations.create(
          registration("legacy@example.test", session.id),
        );
        const insert = (call: string, content: string) => sql`INSERT INTO send
        (handle, conversation_id, kind, content, tool_call_id, state, recorded_at, updated_at)
        VALUES (${conversation.handle}, ${conversation.id}, 'text', ${content}, ${call}, 'recorded', 0, 0)`;
        yield* insert("old-call", "private old message");
        yield* insert("other-call", "private other message");
        const handler = operatorHandler(host.operator);
        yield* Effect.addFinalizer(() => Effect.promise(handler.dispose));
        const connection = yield* serveTestOperator(handler.handler);
        const command = (handle: string, call = "old-call") =>
          runOperatorCli(["release-send", handle, call], connection);
        expect(yield* command("missing@example.test")).toBe("Send recovery: not_found");
        expect(yield* command(conversation.handle, "missing-call")).toBe(
          "Send recovery: not_found",
        );
        const denied = yield* Effect.promise(() =>
          fetch(`${connection.url}/operator/release-send`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ handle: conversation.handle, callID: "old-call" }),
          }),
        );
        expect(denied.status).toBe(401);
        expect(yield* command(conversation.handle)).toBe("Send recovery: released");
        expect(yield* command(conversation.handle)).toBe("Send recovery: settled");
        expect(yield* sql`SELECT tool_call_id AS call, state FROM send ORDER BY id`).toEqual([
          { call: "old-call", state: "failed" },
          { call: "other-call", state: "recorded" },
        ]);
        expect(yield* host.conversations.bySession(session.id)).toEqual(conversation);
        expect(fake.bubbles).toEqual([]);
        const sends = yield* outbox(
          fake.messages,
          fakeGestures().gestures,
          host.personas,
          undefined,
          undefined,
          { typing: false },
        );
        expect(yield* sends.send(conversation, "next", "blocked-call")).toBe(
          "not sent: an earlier send is still in doubt",
        );
        // Late evidence is reconciled rather than overwritten by an operator release.
        yield* fake.outgoing(conversation.handle, "private other message", 1, "delivered");
        const configured = runOperatorCli(["release-send", conversation.handle, "other-call"]).pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                API_APP_URL: connection.url,
                TOKEN_MANAGEMENT: connection.token,
              }),
            ),
          ),
        );
        expect(yield* configured).toBe("Send recovery: settled");
        expect((yield* sends.results(session.id)).map((row) => row.state)).toEqual([
          "failed",
          "delivered",
        ]);
        expect(yield* sends.send(conversation, "next", "observed")).toContain("did go out");
        expect(yield* sends.send(conversation, "next", "next")).toBe("sent");
        expect(fake.bubbles.map((bubble) => bubble.text)).toEqual(["next"]);
        const attemptID = crypto.randomUUID().toUpperCase();
        yield* sql`INSERT INTO send
          (handle, conversation_id, kind, content, tool_call_id, state, recorded_at, updated_at, attempt_id, guid)
          VALUES (${conversation.handle}, ${conversation.id}, 'text', 'pending', 'identified', 'uncertain', 0, 0, ${attemptID}, ${attemptID})`;
        yield* fake.outgoing(conversation.handle, "pending", 1, "unknown", attemptID);
        expect(yield* command(conversation.handle, "identified")).toBe("Send recovery: uncertain");
        const captured = captureDiagnostics();
        const resolve = fake.messages.resolveSend.bind(fake.messages);
        try {
          fake.messages.resolveSend = () =>
            Effect.fail(
              Object.assign(new Error("private transport input"), { code: "ECONNRESET" }),
            );
          const response = yield* Effect.promise(() =>
            applicationRequest(
              new Request("https://app.test/release-send", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ handle: conversation.handle, callID: "identified" }),
              }),
              handler.handler,
            ),
          );
          expect(response.status).toBe(503);
          const correlation = response.headers.get("x-request-id")!;
          expect(yield* Effect.promise(() => response.text())).toContain(correlation);
          expect(captured.logs.every((line) => line.includes(correlation))).toBe(true);
          expect(captured.logs.filter((line) => line.includes("causeName"))).toHaveLength(1);
          expect(captured.logs.join("\n")).toContain("ECONNRESET");
          expect(captured.logs.join("\n")).not.toContain("private transport input");
        } finally {
          fake.messages.resolveSend = resolve;
          captured.restore();
        }
        yield* fake.settle(attemptID, "delivered");
        expect(yield* command(conversation.handle, "identified")).toBe("Send recovery: settled");
        yield* insert("racing-call", "racing message");
        // A receipt wins between the last status read and the conditional release write.
        yield* sql`CREATE TRIGGER settled_during_release BEFORE UPDATE OF state ON send
          WHEN OLD.tool_call_id = 'racing-call' AND NEW.state = 'failed' BEGIN
          UPDATE send SET state = 'delivered' WHERE id = OLD.id;
          SELECT RAISE(IGNORE); END`;
        expect(yield* command(conversation.handle, "racing-call")).toBe("Send recovery: settled");
        expect(yield* sql`SELECT state FROM send WHERE tool_call_id = 'racing-call'`).toEqual([
          { state: "delivered" },
        ]);
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const request = (handle: string) =>
  new Request("https://app.test/release-send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, callID: "private-call" }),
  });

test("operator recovery failures retain cause/correlation and never log private inputs", async () => {
  const { logs, restore } = captureDiagnostics();
  const failure = new Error("private message private-token", {
    cause: Object.assign(new Error("private upstream"), { code: "ECONNRESET" }),
  });
  const handler = operatorHandler({
    testHandle: () => Effect.void,
    block: () => Effect.void,
    remove: () => Effect.succeed("not_found"),
    releaseSend: () => Effect.fail(failure),
  });
  try {
    const response = await handler.handler(request("private@example.test"));
    const body = await response.text();
    expect(response.status).toBe(503);
    const requestId = body.match(/[0-9a-f-]{36}/)?.[0];
    expect(requestId).toBeDefined();
    expect(logs.filter((line) => line.includes("send.release"))).toHaveLength(1);
    expect(logs.join("\n")).toContain(requestId);
    expect(logs.join("\n")).toContain("ECONNRESET");
    expect(logs.join("\n")).toContain("outbox.reconcile");
    expect((await handler.handler(request("invalid"))).status).toBe(503);
    for (const value of [
      "private@example.test",
      "private-call",
      "private message",
      "private-token",
      "private upstream",
    ])
      expect(logs.join("\n") + body).not.toContain(value);
  } finally {
    await handler.dispose();
    restore();
  }
});
