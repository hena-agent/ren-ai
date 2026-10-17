import { Effect, Fiber } from "effect";
import { expect, test } from "vitest";
import { registration, runMessagingTest } from "../../test/messaging.test-helper.ts";
import { migrate } from "../database.ts";
import { conversations } from "./conversations.ts";

test("blocking a User prevents both waiting and later admissions to their Conversation", () =>
  runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const directory = yield* conversations;
      const conversation = yield* directory.create(registration("blocked@example.com", "session"));
      const admitted: string[] = [];
      const prompt = Effect.sync(() => admitted.push("stale prompt"));
      const waiting = yield* directory.withHandle(conversation.handle)(
        Effect.gen(function* () {
          const attempt = yield* Effect.forkScoped(
            directory.admit(conversation.sessionID, prompt),
            {
              startImmediately: true,
            },
          );
          yield* directory.block(conversation.handle);
          return attempt;
        }),
      );
      yield* Fiber.join(waiting);
      yield* directory.admit(conversation.sessionID, prompt);
      expect(admitted).toEqual([]);
    }),
  ));
