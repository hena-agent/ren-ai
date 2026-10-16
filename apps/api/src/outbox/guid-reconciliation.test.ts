import { Effect } from "effect";
import { expect, test } from "vitest";
import { fakeGestures, fakeMessages } from "@ren-ai/imsg/testing";
import { outbox } from "./outbox.ts";
import { conversations } from "../conversations/conversations.ts";
import { migrate } from "../database.ts";
import { registration, runMessagingTest } from "../../test/messaging.test-helper.ts";

test("a send with an observed GUID settles without fetching conversation history", async () => {
  await runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const directory = yield* conversations;
      const conversation = yield* directory.create(registration("guid@example.com", "ses_guid"));
      const fake = fakeMessages();
      const sends = yield* outbox(
        {
          ...fake.messages,
          recent: () => Effect.fail(new Error("History must not be fetched for a known GUID")),
        },
        fakeGestures().gestures,
        new Map([["persona1", { timeZone: "UTC" }]]),
      );
      let notifications = 0;
      sends.onSent(() =>
        Effect.sync(() => {
          notifications++;
        }),
      );
      expect(yield* sends.send(conversation, "hello", "first")).toBe("sent");
      expect(yield* sends.send(conversation, "hello", "first")).toContain("already recorded");
      expect(fake.bubbles).toHaveLength(1);
      expect(notifications).toBe(1);
    }),
  );
});
