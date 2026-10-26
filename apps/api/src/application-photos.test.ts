import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { fakeGestures, fakeMessages } from "@ren-ai/imsg/testing";
import { runMessagingTest } from "../test/messaging.test-helper.ts";
import { prepareMessaging } from "./application-tools.ts";
import { fixture, input } from "./photos/photos.test-helper.ts";
import { makeOperator } from "./operator/operator.ts";

test("Conversation tools generate, reconsider a cancelled photo, send once, and durably remove private bytes", async () => {
  await runMessagingTest(
    Effect.gen(function* () {
      const f = yield* fixture;
      f.fetcher.mockResolvedValue(
        Response.json({
          data: [{ b64_json: Buffer.from([255, 216, 255, 0, 255, 217]).toString("base64") }],
        }),
      );
      const fake = fakeMessages();
      const gestures = fakeGestures();
      const app = yield* prepareMessaging(
        f.options.personas,
        fake.messages,
        gestures.gestures,
        f.photos,
      );
      const session = f.conversation.sessionID;
      expect(yield* app.tools.takePhoto("sandbox", input, "sandbox")).toEqual({
        status: "declined",
      });
      expect(yield* app.tools.sendPhoto("sandbox", "private", "sandbox")).toContain("not sent");
      const disabled = yield* prepareMessaging(
        f.options.personas,
        fake.messages,
        gestures.gestures,
      );
      expect(yield* disabled.tools.takePhoto(session, input, "no-service")).toEqual({
        status: "declined",
      });
      expect(yield* disabled.tools.sendPhoto(session, "private", "no-service")).toContain(
        "not sent",
      );
      const photo = yield* app.tools.takePhoto(session, input, "take");
      expect(photo.status).toBe("taken");
      if (photo.status !== "taken") throw new Error("Expected a photo");
      expect(yield* app.tools.sendPhoto(f.other.sessionID, photo.photo, "foreign")).toContain(
        "not sent",
      );
      yield* app.pace.onNew(session, "new-message");
      expect(yield* app.tools.sendPhoto(session, photo.photo, "cancelled")).toContain(
        "Keep this photo",
      );
      yield* app.tools.context(session, ["new-message"]);
      const send = yield* app.tools.sendPhoto(session, photo.photo, "send").pipe(Effect.forkScoped);
      yield* TestClock.adjust("4 seconds");
      expect(yield* Fiber.join(send)).toBe("sent");
      expect(yield* app.tools.sendPhoto(session, photo.photo, "duplicate")).toContain("not sent");
      expect(yield* fake.messages.recent(f.conversation.handle, 0)).toHaveLength(1);
      expect(f.fetcher).toHaveBeenCalledTimes(1);
      expect(gestures.typing).toEqual([]);
      yield* TestClock.adjust("2 hours");
      yield* f.photos.cleanup();
      expect(f.objects.size).toBe(1);
      const operator = yield* makeOperator(app.directory, () => Effect.void);
      expect(yield* operator.remove(f.conversation.handle)).toBe("removed");
      yield* f.photos.cleanup();
      expect(f.objects.size).toBe(0);
      expect(
        yield* f.sql`SELECT * FROM conversation_photo WHERE conversation_id = ${f.conversation.id}`,
      ).toEqual([]);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
