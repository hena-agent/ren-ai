import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { fakeGestures, fakeMessages } from "@ren-ai/imsg/testing";
import { registration, runMessagingTest } from "../test/messaging.test-helper.ts";
import { prepareMessaging } from "./application-tools.ts";

test.each([
  ["Asia/Seoul", "read 00:05", "sent 00:06"],
  ["America/New_York", "read 11:05", "sent 11:06"],
])("messaging results use %s and the completion time", async (timeZone, read, sent) => {
  await runMessagingTest(
    Effect.gen(function* () {
      const messages = fakeMessages();
      const gestures = fakeGestures();
      const persona = {
        id: "persona1",
        timeZone,
        language: "ko",
        openingLine: "Hi",
        memory: "Remember.",
        prompt: "You are Persona1.",
      };
      const app = yield* prepareMessaging(new Map([[persona.id, persona]]), messages.messages, {
        ...gestures.gestures,
        read: (handle) =>
          Effect.sleep("2 seconds").pipe(Effect.andThen(gestures.gestures.read(handle))),
      });
      const conversation = yield* app.directory.create(
        registration("timing@example.com", "session"),
      );
      yield* TestClock.setTime(Date.parse("2026-09-25T15:04:59Z"));
      const reading = yield* app.tools.read(conversation.sessionID).pipe(Effect.forkScoped);
      yield* TestClock.adjust("2 seconds");
      expect(yield* Fiber.join(reading)).toBe(read);
      expect(gestures.reads).toEqual([conversation.handle]);
      yield* TestClock.setTime(Date.parse("2026-09-25T15:05:59Z"));
      yield* app.pace.onNew(conversation.sessionID, "new-message");
      yield* app.tools.context(conversation.sessionID, ["new-message"]);
      const sending = yield* app.tools
        .send(conversation.sessionID, "Hi", "send")
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust("4 seconds");
      expect(yield* Fiber.join(sending)).toBe(sent);
      expect(messages.bubbles).toEqual([{ handle: conversation.handle, text: "Hi" }]);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
