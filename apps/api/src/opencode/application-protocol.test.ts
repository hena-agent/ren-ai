import { Effect } from "effect";
import { expect, test } from "vitest";
import {
  applicationRpcFixture,
  malformedRpcReply,
} from "../../test/application-rpc.test-helper.ts";
import { runMessagingTest } from "../../test/messaging.test-helper.ts";

test.each([
  ["send", { sessionID: "session", callID: "send-call" }],
  ["send", { sessionID: 1, text: "text", callID: "send-call" }],
  ["send", { sessionID: "session", text: "text", callID: 1 }],
  ["wait", { sessionID: "session", seconds: "later" }],
  ["wait", { sessionID: 1, seconds: 60 }],
  ["react", { sessionID: "session", tapback: "like" }],
  ["react", { sessionID: "session", tapback: "unsupported", callID: "react-call" }],
  ["alert", { name: "problem", detail: 1 }],
  ["alert", { detail: "problem" }],
])("the application HTTP boundary rejects invalid %s arguments", (tag, payload) =>
  runMessagingTest(
    Effect.gen(function* () {
      const fixture = yield* applicationRpcFixture;
      const response = yield* Effect.promise(() => fixture.request(tag, payload));
      expect(yield* Effect.promise(() => response.text())).toContain('"_tag":"Failure"');
      expect(fixture.messages.bubbles).toEqual([]);
      expect(fixture.gestures.reactions).toEqual([]);
      expect(fixture.alerts).toEqual([]);
    }),
  ),
);

test.each([
  { tag: "catalog", value: [{ id: "persona1" }] },
  { tag: "status", value: { delivered: "true", readAt: null } },
  { tag: "sends", value: [{ toolCallID: 1, state: "sent", updatedAt: 100 }] },
] as const)("the application client rejects malformed $tag results", async ({ tag, value }) => {
  await expect(
    runMessagingTest(
      Effect.gen(function* () {
        const fixture = yield* applicationRpcFixture;
        fixture.transport.fetch = (request) => malformedRpcReply(request, value);
        const calls = {
          catalog: fixture.client.catalog().pipe(Effect.asVoid),
          status: fixture.client.status({ sessionID: "session" }).pipe(Effect.asVoid),
          sends: fixture.client.sends({ sessionID: "session" }).pipe(Effect.asVoid),
        };
        yield* calls[tag];
      }),
    ),
  ).rejects.toThrow(/Expected|Missing/);
});

test("the application catalog and diagnostics preserve their public data", () =>
  runMessagingTest(
    Effect.gen(function* () {
      const fixture = yield* applicationRpcFixture;
      expect(yield* fixture.client.catalog()).toEqual([fixture.persona]);
      yield* fixture.client.alert({ name: "watch", detail: "disconnected" });
      expect(fixture.alerts).toEqual([{ name: "watch", detail: "disconnected" }]);
      fixture.messages.status(fixture.conversation.handle, { delivered: true, readAt: 1234 });
      expect(yield* fixture.client.status({ sessionID: "session" })).toEqual({
        delivered: true,
        readAt: 1234,
      });
    }),
  ));
