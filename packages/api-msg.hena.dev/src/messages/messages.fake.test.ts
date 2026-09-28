import { Effect } from "effect";
import { expect, test } from "vitest";
import { fakeMessages } from "./messages.fake.ts";

test("an accepted iMessage starts sent, before Apple reports delivery or reading", async () => {
  const fake = fakeMessages();
  await Effect.runPromise(fake.messages.sendText("user@example.com", "hello"));
  expect(await Effect.runPromise(fake.messages.lastOutgoingStatus("user@example.com"))).toEqual({
    delivered: false,
    readAt: null,
  });
});
