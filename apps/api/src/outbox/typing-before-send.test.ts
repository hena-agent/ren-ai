import { SqliteClient } from "@effect/sql-sqlite-node";
import { Deferred, Effect, Fiber, Random } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { conversations } from "../conversations/conversations.ts";
import { migrate } from "../database.ts";
import { fakeGestures, fakeMessages } from "@ren-ai/imsg/testing";
import { outbox } from "./outbox.ts";

const personas = new Map([["persona1", { timeZone: "Asia/Seoul" }]]);

test("a send shows typing before the text goes out, even while a read holds the Messages UI", async () => {
  const events: string[] = [];
  const ui = fakeGestures(events);
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
      const typingRequested = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // The Mac's typing waits its turn for the Messages UI that the persona's read still holds.
      const gestures = {
        ...ui.gestures,
        typing: (handle: string, text: string, durationMillis: number) =>
          Deferred.succeed(typingRequested, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(ui.gestures.typing(handle, text, durationMillis)),
          ),
      };
      const sends = yield* outbox(
        fakeMessages(events).messages,
        gestures,
        personas,
        directory.active,
      );
      const sending = yield* Effect.forkScoped(sends.send(conversation, "hi", "call-1"));
      yield* Deferred.await(typingRequested);
      // Longer than any typing time: a send that gives up on the busy UI goes out here.
      yield* TestClock.adjust("3 seconds");
      expect(events).toEqual([]);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(sending)).toBe("sent");
      expect(events).toEqual(["typing", "send"]);
      expect(ui.typing.map((typing) => typing.handle)).toEqual(["alice@example.com"]);
    }).pipe(
      Effect.scoped,
      Random.withSeed("typing-before-send"),
      Effect.provide(TestClock.layer()),
      Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
    ),
  );
});
