import { Deferred, Effect, Fiber } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { applicationRpcFixture } from "../../test/application-rpc.test-helper.ts";
import { runMessagingTest } from "../../test/messaging.test-helper.ts";
import { prepareMessaging } from "../application-tools.ts";

const restart = (f: Effect.Success<typeof applicationRpcFixture>) =>
  prepareMessaging(new Map([[f.persona.id, f.persona]]), f.messages.messages, f.gestures.gestures);

test("one RPC sends distinct bubbles in order, with typing per bubble and durable deduplication", () =>
  runMessagingTest(
    Effect.gen(function* () {
      const f = yield* applicationRpcFixture;
      const input = {
        sessionID: f.conversation.sessionID,
        callID: "three-bubbles",
        messages: [
          { text: "아직" },
          { text: "왜\n무슨 일 있어?", delaySeconds: 1.5 },
          { text: "나 이제 끝났어", delaySeconds: 0 },
        ],
      };
      const results = yield* Effect.all([f.client.send(input), f.client.send(input)], {
        concurrency: "unbounded",
      });
      expect(results).toContain("Bubble 1: sent\nBubble 2: sent\nBubble 3: sent");
      expect(results.join("\n")).toContain("this call was already recorded");
      expect(f.messages.bubbles).toEqual(
        input.messages.map(({ text }) => ({ handle: f.conversation.handle, text })),
      );
      expect(f.gestures.typing).toHaveLength(3);
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT tool_call_id AS id, state FROM send ORDER BY id`).toEqual([
        { id: input.callID, state: "sent" },
        { id: `${input.callID}:bubble:2`, state: "sent" },
        { id: `${input.callID}:bubble:3`, state: "sent" },
      ]);
      const restarted = yield* restart(f);
      const repeated = yield* restarted.tools.send(input.sessionID, input.messages, input.callID);
      expect(repeated).toContain("no bubbles were sent again");
      expect(repeated).toContain("Bubble 3: sent");
      expect(f.messages.bubbles).toHaveLength(3);
    }),
  ));

test("a new arrival while typing the second bubble cancels the remaining reply, including after restart", () =>
  runMessagingTest(
    Effect.gen(function* () {
      const f = yield* applicationRpcFixture;
      const typing = f.gestures.gestures.typing.bind(f.gestures.gestures);
      let count = 0;
      f.gestures.gestures.typing = (handle, text, duration) =>
        Effect.gen(function* () {
          if (++count === 2) yield* f.prepared.pace.onNew(f.conversation.sessionID, "incoming");
          return yield* typing(handle, text, duration);
        });
      const messages = [
        { text: "첫 반응" },
        { text: "이전 설명", delaySeconds: 30 },
        { text: "이전 덧붙임" },
      ];
      const result = yield* f.client.send({
        sessionID: f.conversation.sessionID,
        messages,
        callID: "interrupted",
      });
      expect(result).toBe(
        "Bubble 1: sent\nBubble 2: not sent: a new message arrived\nRemaining 1 bubbles not attempted.",
      );
      expect(f.messages.bubbles.map((row) => row.text)).toEqual([messages[0]!.text]);
      const restarted = yield* restart(f);
      const repeat = yield* restarted.tools.send(f.conversation.sessionID, messages, "interrupted");
      expect(repeat).toContain("Bubble 1: sent\nBubble 2: not attempted\nBubble 3: not attempted");
      expect(f.messages.bubbles).toHaveLength(1);
      yield* f.client.context({ sessionID: f.conversation.sessionID, messageIDs: ["incoming"] });
      expect(
        yield* f.client.send({
          sessionID: f.conversation.sessionID,
          messages: [{ text: "새 맥락에 대한 반응" }],
          callID: "fresh",
        }),
      ).toBe("sent");
    }),
  ));

test("an interrupted transport attempt is never repeated and never releases the remaining bubbles", () =>
  runMessagingTest(
    Effect.gen(function* () {
      const f = yield* applicationRpcFixture;
      const entered = yield* Deferred.make<void>();
      const send = f.messages.messages.sendText.bind(f.messages.messages);
      f.messages.messages.sendText = (handle, text, id) =>
        text === "second"
          ? f.messages
              .outgoing(handle, text, Date.now(), "unknown", id)
              .pipe(
                Effect.andThen(Deferred.succeed(entered, undefined)),
                Effect.andThen(Effect.never),
              )
          : send(handle, text, id);
      const input = {
        sessionID: f.conversation.sessionID,
        callID: "uncertain",
        messages: [{ text: "first" }, { text: "second" }, { text: "third" }],
      };
      const sending = yield* f.prepared.tools
        .send(input.sessionID, input.messages, input.callID)
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(sending);
      const restarted = yield* restart(f);
      const repeat = yield* restarted.tools.send(input.sessionID, input.messages, input.callID);
      expect(repeat).toContain("Bubble 1: sent\nBubble 2: recorded\nBubble 3: not attempted");
      expect(
        (yield* f.messages.messages.recent(f.conversation.handle, 0)).map((row) => row.text),
      ).toEqual(["first", "second"]);
      expect(
        yield* restarted.tools.send(input.sessionID, [{ text: "another reply" }], "new-call"),
      ).toBe("not sent: an earlier send is still in doubt");
    }),
  ));
