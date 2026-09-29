import { SqliteClient } from "@effect/sql-sqlite-node";
import { Clock, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { conversations } from "../conversations/conversations.ts";
import { migrate } from "../database.ts";
import { fakeGestures } from "../gestures/gestures.fake.ts";
import { fakeMessages } from "../messages/messages.fake.ts";
import { captureSendLogs } from "../messages/send-diagnostic.test-helper.ts";
import { sendDiagnostic } from "../messages/send-diagnostic.ts";
import { outbox } from "./outbox.ts";

const personas = new Map([["persona1", { timeZone: "Asia/Seoul" }]]);
const registration = (handle: string, sessionID: string) => ({
  handle,
  sessionID,
  locale: "ko",
  consentVersion: "v1",
  consentLanguage: "ko",
  personaID: "persona1",
});

test("a failed send traces its eventual matching row once without logging private inputs or a Notice", async () => {
  const { logs, records, logger } = captureSendLogs();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* migrate;
        const conversation = yield* (yield* conversations).create(
          registration("PRIVATE_HANDLE_SENTINEL", "diagnostic"),
        );
        const fake = fakeMessages();
        const debug = sendDiagnostic();
        const sends = yield* outbox(
          {
            ...fake.messages,
            sendText: (handle, text) =>
              text === "PRIVATE_TEXT_SENTINEL"
                ? Effect.fail(new Error("PRIVATE_ERROR_SENTINEL"))
                : fake.messages.sendText(handle, text),
          },
          fakeGestures().gestures,
          personas,
          undefined,
          undefined,
          debug,
        );
        yield* sends.notice(conversation.handle, "notice");
        expect(logs).toEqual([]);
        expect(yield* sends.send(conversation, "PRIVATE_TEXT_SENTINEL", "diagnostic-call")).toBe(
          "not sent: send in doubt",
        );
        const row = yield* fake.outgoing(
          conversation.handle,
          "PRIVATE_TEXT_SENTINEL",
          yield* Clock.currentTimeMillis,
          "sent",
          "PRIVATE_GUID_SENTINEL",
        );
        expect(yield* sends.reconcile(conversation, row)).toBe(true);
        expect(yield* sends.send(conversation, "later", "later-call")).toContain("did go out");
        expect(yield* sends.send(conversation, "another", "another-call")).toBe("sent");
        expect(logs).toHaveLength(4);

        const absent = yield* (yield* conversations).create(
          registration("absent-diagnostic@example.com", "absent-diagnostic"),
        );
        const other = fakeMessages();
        const missing = yield* outbox(
          {
            ...other.messages,
            sendText: (_handle: string, _text: string) => Effect.fail(new Error("uncertain")),
          },
          fakeGestures().gestures,
          personas,
          undefined,
          undefined,
          sendDiagnostic(),
        );
        expect(yield* missing.send(absent, "first", "diagnostic-1")).toBe(
          "not sent: send in doubt",
        );
        const laterAttempt = yield* Effect.forkScoped(missing.send(absent, "next", "diagnostic-2"));
        yield* TestClock.adjust("3 seconds");
        expect(yield* Fiber.join(laterAttempt)).toBe("not sent: send in doubt");

        const successful = yield* (yield* conversations).create(
          registration("successful-diagnostic@example.com", "successful-diagnostic"),
        );
        const delivered = fakeMessages();
        const confirmed = yield* outbox(
          delivered.messages,
          fakeGestures().gestures,
          personas,
          undefined,
          undefined,
          sendDiagnostic(),
        );
        expect(yield* confirmed.send(successful, "success", "diagnostic-3")).toBe("sent");
      }).pipe(
        Effect.withLogger(logger),
        Effect.provide(TestClock.layer()),
        Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
  );
  expect(logs).toHaveLength(11);
  expect(logs.join("\n")).not.toContain("PRIVATE_");
  expect(records.join("\n")).not.toContain("PRIVATE_");
  expect(logs.join("\n")).toContain('"event":"outbox-result","id":2,"outcome":"failure"');
  expect(logs.join("\n")).toContain('"event":"row-confirmed"');
  expect(logs.filter((line) => line.includes('"event":"attempt"'))).toHaveLength(3);
  expect(logs.join("\n")).toContain('"event":"settled-without-row"');
  expect(logs.join("\n")).toContain('"outcome":"success"');
});
