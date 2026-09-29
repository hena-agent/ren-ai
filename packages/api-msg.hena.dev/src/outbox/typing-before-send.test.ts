import { SqliteClient } from "@effect/sql-sqlite-node";
import { Deferred, Effect, Fiber, Random } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { setup } from "../../test/messages-ui.test-helper.ts";
import { conversations } from "../conversations/conversations.ts";
import { migrate } from "../database.ts";
import { fakeMessages } from "../messages/messages.fake.ts";
import { outbox } from "./outbox.ts";

const personas = new Map([["persona1", { timeZone: "Asia/Seoul" }]]);

test("a send shows typing before the text goes out, even while a read holds the Messages UI", async () => {
  const ui = await setup();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* migrate;
      const directory = yield* conversations;
      const conversation = yield* directory.create({
        handle: "alice@example.com",
        locale: "ko",
        consentVersion: "v1",
        consentLanguage: "ko",
        personaID: "persona1",
        sessionID: "s1",
      });
      const holding = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const typingRequested = yield* Deferred.make<void>();
      const gestures = {
        ...ui.gestures,
        typing: (handle: string, text: string, durationMillis: number) =>
          Effect.andThen(
            Deferred.succeed(typingRequested, undefined),
            ui.gestures.typing(handle, text, durationMillis),
          ),
      };
      const sends = yield* outbox(
        fakeMessages(ui.events).messages,
        gestures,
        personas,
        directory.active,
      );
      ui.blockAction(
        "read",
        Effect.andThen(Deferred.succeed(holding, undefined), Deferred.await(release)),
      );
      // The persona calls read and send in one step; read takes the Messages UI first.
      yield* Effect.forkScoped(ui.gestures.read(conversation.handle));
      yield* Deferred.await(holding);
      const sending = yield* Effect.forkScoped(sends.send(conversation, "hi", "call-1"));
      yield* Deferred.await(typingRequested);
      // Longer than any typing time: a send that gives up on the busy UI goes out here.
      yield* TestClock.adjust("3 seconds");
      yield* Deferred.succeed(release, undefined);
      yield* TestClock.adjust("3 seconds");
      expect(yield* Fiber.join(sending)).toBe("sent");
      expect(ui.events.filter((event) => /^(read|key|send)/.test(event))).toEqual([
        "read sms://open?groupid=alice%40example.com",
        "key h",
        "key i",
        "send",
      ]);
    }).pipe(
      Effect.scoped,
      Random.withSeed("typing-before-send"),
      Effect.provide(TestClock.layer()),
      Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
    ),
  );
});
