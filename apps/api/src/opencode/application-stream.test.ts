import { Effect } from "effect";
import { expect, test } from "vitest";
import { applicationRpcFixture } from "../../test/application-rpc.test-helper.ts";
import { runMessagingTest } from "../../test/messaging.test-helper.ts";

test("the application returns context in one finite response and no longer hosts waits", () =>
  runMessagingTest(
    Effect.gen(function* () {
      const fixture = yield* applicationRpcFixture;
      expect(yield* fixture.client.context({ sessionID: "session", messageIDs: [] })).toEqual({
        status: undefined,
        sends: [],
      });
      const response = yield* Effect.promise(() =>
        fixture.request("wait", { sessionID: "session", seconds: 3300 }),
      );
      const body = yield* Effect.promise(() => response.text());
      expect(body).not.toContain('"_tag":"Chunk"');
      expect(body).not.toContain("paused");
    }),
  ));
