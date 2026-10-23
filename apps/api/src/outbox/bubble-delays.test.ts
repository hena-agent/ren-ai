import { Clock, Deferred, Effect, Fiber, Random } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { applicationRpcFixture } from "../../test/application-rpc.test-helper.ts";
import { runMessagingTest } from "../../test/messaging.test-helper.ts";

test("AI-selected intervals include typing time instead of adding a second wait", () =>
  runMessagingTest(
    Effect.gen(function* () {
      const f = yield* applicationRpcFixture;
      const started = yield* Effect.forEach([0, 1, 2], () => Deferred.make<number>());
      let index = 0;
      f.gestures.gestures.typing = (_handle, _text, duration) =>
        Deferred.succeed(started[index++]!, duration).pipe(
          Effect.andThen(Effect.sleep(duration)),
          Effect.as(true),
        );
      const messages = [
        { text: "첫 반응", delaySeconds: 0 },
        { text: "이어서 설명하는 말풍선", delaySeconds: 1.5 },
        { text: "음", delaySeconds: 30 },
      ];
      const sending = yield* f.prepared.tools
        .send(f.conversation.sessionID, messages, "paced")
        .pipe(Effect.forkScoped);
      const first = yield* Deferred.await(started[0]!);
      expect(first).toBeGreaterThanOrEqual(1000);
      yield* TestClock.adjust(first - 1);
      expect(f.messages.bubbles).toEqual([]);
      yield* TestClock.adjust(1);
      const second = yield* Deferred.await(started[1]!);
      expect(second).toBeGreaterThan(1500);
      expect(f.messages.bubbles.map((row) => row.text)).toEqual([messages[0]!.text]);
      yield* TestClock.adjust(second);
      expect(yield* Deferred.await(started[2]!)).toBeLessThanOrEqual(15000);
      yield* TestClock.adjust(29999);
      expect(f.messages.bubbles).toHaveLength(2);
      yield* TestClock.adjust(1);
      expect(yield* Fiber.join(sending)).toBe("Bubble 1: sent\nBubble 2: sent\nBubble 3: sent");
      const rows = yield* f.messages.messages.recent(f.conversation.handle, 0);
      expect(rows.map((row) => row.text)).toEqual(messages.map((bubble) => bubble.text));
      expect(rows[1]!.createdAt - rows[0]!.createdAt).toBeCloseTo(second, 5);
      expect(rows[2]!.createdAt - rows[1]!.createdAt).toBeCloseTo(30000, 5);
    }).pipe(
      Effect.provide(TestClock.layer()),
      Effect.provideService(Random.Random, { nextIntUnsafe: () => 0, nextDoubleUnsafe: () => 0.5 }),
    ),
  ));

test("new input during an AI-selected pause cancels the remaining bubbles promptly", () =>
  runMessagingTest(
    Effect.gen(function* () {
      const f = yield* applicationRpcFixture;
      const waiting = yield* Deferred.make<void>();
      f.gestures.gestures.typing = (_handle, text, duration) =>
        text === "first"
          ? Effect.succeed(true)
          : Deferred.succeed(waiting, undefined).pipe(
              Effect.andThen(Effect.sleep(duration)),
              Effect.as(true),
            );
      const sending = yield* f.prepared.tools
        .send(
          f.conversation.sessionID,
          [{ text: "first" }, { text: "second", delaySeconds: 30 }, { text: "third" }],
          "interrupted-pause",
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(waiting);
      yield* TestClock.adjust(20000);
      yield* f.prepared.pace.onNew(f.conversation.sessionID, "new-message");
      expect(yield* Fiber.join(sending)).toBe(
        "Bubble 1: sent\nBubble 2: not sent: a new message arrived\nRemaining 1 bubbles not attempted.",
      );
      yield* TestClock.adjust(60000);
      expect(f.messages.bubbles.map((row) => row.text)).toEqual(["first"]);
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("a failed typing transport waits only the unelapsed portion of the selected interval", () =>
  runMessagingTest(
    Effect.gen(function* () {
      const f = yield* applicationRpcFixture;
      const waiting = yield* Deferred.make<void>();
      f.gestures.gestures.typing = () =>
        Deferred.succeed(waiting, undefined).pipe(
          Effect.andThen(Effect.sleep(5000)),
          Effect.andThen(Effect.fail(new Error("typing unavailable"))),
        );
      const start = yield* Clock.currentTimeMillis;
      const sending = yield* f.prepared.tools
        .send(
          f.conversation.sessionID,
          [{ text: "one bubble", delaySeconds: 30 }],
          "typing-fallback",
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(waiting);
      yield* TestClock.adjust(5000);
      yield* TestClock.adjust(24999);
      expect(f.messages.bubbles).toEqual([]);
      yield* TestClock.adjust(1);
      expect(yield* Fiber.join(sending)).toBe("sent");
      expect((yield* Clock.currentTimeMillis) - start).toBe(30000);
    }).pipe(Effect.provide(TestClock.layer())),
  ));
