import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { captureSendLogs } from "./send-diagnostic.test-helper.ts";
import { sendDiagnostic } from "./send-diagnostic.ts";

test("one persona attempt logs only allowlisted metadata through a later reconciliation", async () => {
  const { logs, records, logger } = captureSendLogs();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(1000);
      const debug = sendDiagnostic();
      const handle = "PRIVATE_HANDLE_SENTINEL";
      const text = "PRIVATE_TEXT_SENTINEL";
      const guid = "PRIVATE_GUID_SENTINEL";
      expect(yield* debug.claim(7, handle, text)).toBe(true);
      expect(yield* debug.claim(8, "other", "other")).toBe(false);
      yield* debug.ack(handle, text, {
        ok: true,
        id: 1,
        guid,
        message_id: "PRIVATE_MESSAGE_ID_SENTINEL",
        transport: "bridge",
        status: "delivered",
        service: "PRIVATE_SERVICE_SENTINEL",
        chat_guid: "PRIVATE_CHAT_GUID_SENTINEL",
        secret: "PRIVATE_SECRET_SENTINEL",
      });
      yield* TestClock.adjust("100 millis");
      yield* debug.result(7, "success");
      yield* TestClock.adjust("100 millis");
      yield* debug.row(7, "unknown");
      yield* TestClock.adjust("100 millis");
      yield* debug.row(7, "delivered");
      expect(yield* debug.claim(9, "later", "later")).toBe(false);
      yield* debug.ack(handle, text, { ok: true, guid });
      yield* debug.row(7, "delivered");
    }).pipe(Effect.withLogger(logger), Effect.provide(TestClock.layer())),
  );
  expect(logs).toEqual([
    '[DEBUG-ren-ai-send] {"event":"attempt","id":7}',
    '[DEBUG-ren-ai-send] {"event":"rpc-ack","id":7,"fields":["ok","id","guid","message_id","transport","status","service","chat_guid"],"ok":true,"transport":"bridge","status":"delivered","guidPresent":true}',
    '[DEBUG-ren-ai-send] {"event":"outbox-result","id":7,"outcome":"success","elapsedMs":100}',
    '[DEBUG-ren-ai-send] {"event":"row-observed","id":7,"elapsedMs":200}',
    '[DEBUG-ren-ai-send] {"event":"row-confirmed","id":7,"status":"delivered","elapsedMs":300}',
  ]);
  expect(logs.join("\n")).not.toMatch(/PRIVATE_/);
  expect(records.join("\n")).not.toMatch(/PRIVATE_/);
});

test("an RPC error logs only its numeric code, and a missing row ends the one-shot", async () => {
  const { logs, records, logger } = captureSendLogs();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(2000);
      const debug = sendDiagnostic();
      yield* debug.claim(3, "PRIVATE_HANDLE_SENTINEL", "PRIVATE_TEXT_SENTINEL");
      yield* debug.rpcError("PRIVATE_HANDLE_SENTINEL", "PRIVATE_TEXT_SENTINEL", -32001);
      yield* TestClock.adjust("100 millis");
      yield* debug.result(3, "failure");
      yield* TestClock.adjust("100 millis");
      yield* debug.missing(3);
      expect(yield* debug.claim(4, "other", "other")).toBe(false);
      yield* debug.rpcError("PRIVATE_HANDLE_SENTINEL", "PRIVATE_TEXT_SENTINEL", 123);
    }).pipe(Effect.withLogger(logger), Effect.provide(TestClock.layer())),
  );
  expect(logs).toEqual([
    '[DEBUG-ren-ai-send] {"event":"attempt","id":3}',
    '[DEBUG-ren-ai-send] {"event":"rpc-error","id":3,"code":-32001}',
    '[DEBUG-ren-ai-send] {"event":"outbox-result","id":3,"outcome":"failure","elapsedMs":100}',
    '[DEBUG-ren-ai-send] {"event":"settled-without-row","id":3,"elapsedMs":200}',
  ]);
  expect(logs.join("\n")).not.toMatch(/PRIVATE_/);
  expect(records.join("\n")).not.toMatch(/PRIVATE_/);
});

test("unrecognized fields and unrelated sends never leak, and confirmation can precede the RPC result", async () => {
  const { logs, records, logger } = captureSendLogs();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(3000);
      const debug = sendDiagnostic();
      yield* debug.claim(42, "PRIVATE_HANDLE_SENTINEL", "PRIVATE_TEXT_SENTINEL");
      yield* debug.ack("other", "PRIVATE_TEXT_SENTINEL", { ok: true });
      yield* debug.ack("PRIVATE_HANDLE_SENTINEL", "other", { ok: true });
      yield* debug.rpcError("other", "PRIVATE_TEXT_SENTINEL", 123);
      yield* debug.decodeError("other", "PRIVATE_TEXT_SENTINEL");
      yield* debug.row(43, "sent");
      yield* debug.missing(43);
      yield* debug.ack("PRIVATE_HANDLE_SENTINEL", "PRIVATE_TEXT_SENTINEL", {
        ok: "PRIVATE_OK_SENTINEL",
        transport: "PRIVATE_TRANSPORT_SENTINEL",
        status: "PRIVATE_STATUS_SENTINEL",
        guid: null,
        PRIVATE_KEY_SENTINEL: "PRIVATE_VALUE_SENTINEL",
      });
      for (const status of ["pending", "sent", "failed"] as const)
        yield* debug.ack("PRIVATE_HANDLE_SENTINEL", "PRIVATE_TEXT_SENTINEL", {
          ok: false,
          transport: "applescript",
          status,
        });
      yield* debug.decodeError("PRIVATE_HANDLE_SENTINEL", "PRIVATE_TEXT_SENTINEL");
      yield* TestClock.adjust("100 millis");
      yield* debug.row(42, "sent");
      yield* debug.row(42, "failed");
      yield* debug.missing(42);
      yield* debug.result(43, "failure");
      yield* TestClock.adjust("100 millis");
      yield* debug.result(42, "success");
      yield* debug.rpcError("PRIVATE_HANDLE_SENTINEL", "PRIVATE_TEXT_SENTINEL", null);
      yield* debug.decodeError("PRIVATE_HANDLE_SENTINEL", "PRIVATE_TEXT_SENTINEL");
      yield* debug.row(42, "delivered");
      yield* debug.missing(42);
    }).pipe(Effect.withLogger(logger), Effect.provide(TestClock.layer())),
  );
  expect(logs).toEqual([
    '[DEBUG-ren-ai-send] {"event":"attempt","id":42}',
    '[DEBUG-ren-ai-send] {"event":"rpc-ack","id":42,"fields":["ok","guid","transport","status"],"ok":null,"transport":null,"status":null,"guidPresent":false}',
    ...(["pending", "sent", "failed"] as const).map(
      (status) =>
        `[DEBUG-ren-ai-send] {"event":"rpc-ack","id":42,"fields":["ok","transport","status"],"ok":false,"transport":"applescript","status":"${status}","guidPresent":false}`,
    ),
    '[DEBUG-ren-ai-send] {"event":"ack-rejected","id":42}',
    '[DEBUG-ren-ai-send] {"event":"row-observed","id":42,"elapsedMs":100}',
    '[DEBUG-ren-ai-send] {"event":"row-confirmed","id":42,"status":"sent","elapsedMs":100}',
    '[DEBUG-ren-ai-send] {"event":"outbox-result","id":42,"outcome":"success","elapsedMs":200}',
  ]);
  expect(logs.join("\n")).not.toMatch(/PRIVATE_/);
  expect(records.join("\n")).not.toMatch(/PRIVATE_/);
});
