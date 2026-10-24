import { Effect } from "effect";
import { expect, test } from "vitest";
import {
  applicationRpcFixture,
  malformedRpcReply,
} from "../../test/application-rpc.test-helper.ts";
import { runMessagingTest } from "../../test/messaging.test-helper.ts";
import { SqlClient } from "effect/unstable/sql";

test.each([
  ["send", { sessionID: "session", callID: "send-call" }],
  ["send", { sessionID: 1, text: "text", callID: "send-call" }],
  ["send", { sessionID: "session", text: "text", callID: 1 }],
  ["send", { sessionID: "session", text: 1, callID: "send-call" }],
  ["send", { sessionID: "session", messages: [{ text: "obsolete array" }], callID: "send-call" }],
  ["context", { sessionID: 1 }],
  ["observe", { sessionID: 1 }],
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
  { tag: "context", value: { status: { delivered: "true", readAt: null }, sends: [] } },
  { tag: "context", value: { sends: [{ toolCallID: 1, state: "sent", updatedAt: 100 }] } },
  { tag: "context", value: { startingRelationship: "unsupported", status: undefined, sends: [] } },
] as const)("the application client rejects malformed $tag results", async ({ tag, value }) => {
  await expect(
    runMessagingTest(
      Effect.gen(function* () {
        const fixture = yield* applicationRpcFixture;
        fixture.transport.fetch = (request) => malformedRpcReply(request, value);
        const calls = {
          catalog: fixture.client.catalog().pipe(Effect.asVoid),
          context: fixture.client
            .context({ sessionID: "session", messageIDs: [] })
            .pipe(Effect.asVoid),
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
      yield* fixture.client.observe({ sessionID: fixture.conversation.sessionID });
      expect(
        yield* fixture.client.react({
          sessionID: fixture.conversation.sessionID,
          tapback: "love",
          callID: "unseen",
        }),
      ).toContain("not reacted");
      expect(fixture.gestures.reactions).toEqual([]);
      yield* fixture.client.alert({ name: "watch", detail: "disconnected" });
      expect(fixture.alerts).toEqual([{ name: "watch", detail: "disconnected" }]);
      fixture.messages.status(fixture.conversation.handle, { delivered: true, readAt: 1234 });
      expect(yield* fixture.client.context({ sessionID: "session", messageIDs: [] })).toEqual({
        status: { delivered: true, readAt: 1234 },
        sends: [],
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE conversation SET starting_relationship = 'friends' WHERE id = ${fixture.conversation.id}`;
      expect(yield* fixture.client.context({ sessionID: "session", messageIDs: [] })).toMatchObject(
        { startingRelationship: "friends" },
      );
      expect(
        yield* fixture.client.context({ sessionID: "missing", messageIDs: [] }),
      ).not.toHaveProperty("startingRelationship");
    }),
  ));
