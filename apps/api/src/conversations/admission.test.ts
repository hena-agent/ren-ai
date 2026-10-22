import { Effect, Fiber } from "effect";
import { expect, test } from "vitest";
import { registration, runMessagingTest } from "../../test/messaging.test-helper.ts";
import { migrate } from "../database.ts";
import { conversations } from "./conversations.ts";
import { SqlClient } from "effect/unstable/sql";

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

test.each(["superseded", "blocked", "rebuilding"] as const)(
  "live admission revalidates a waiting Conversation after it becomes %s",
  (change) =>
    runMessagingTest(
      Effect.gen(function* () {
        yield* migrate;
        const directory = yield* conversations;
        const original = yield* directory.create(registration("waiting@example.com", "original"));
        const delivered: string[] = [];
        const action = Effect.sync(() => {
          delivered.push("live input");
        });
        const waiting = yield* directory.withHandle(original.handle)(
          Effect.gen(function* () {
            const attempt = yield* directory
              .admitLive(original, action)
              .pipe(Effect.result, Effect.forkScoped({ startImmediately: true }));
            if (change === "blocked") yield* directory.block(original.handle);
            else
              yield* directory.replaceSession(
                original,
                change === "superseded" ? "replacement" : original.sessionID,
              );
            return attempt;
          }),
        );
        expect(yield* Fiber.join(waiting)).toMatchObject({ _tag: "Failure" });
        expect(delivered).toEqual([]);
        if (change !== "blocked") {
          const current = (yield* directory.byHandle(original.handle))!;
          yield* directory.rebuilt(current);
          yield* directory.admitLive(current, action);
          expect(delivered).toEqual(["live input"]);
        }
      }),
    ),
);

test("an unavailable persona assignment rejects Conversation creation without partial user or usage records", () =>
  runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const directory = yield* conversations;
      const sql = yield* SqlClient.SqlClient;
      for (let index = 0; index < 5; index++)
        yield* directory.create(registration(`assigned-${index}@example.com`, `assigned-${index}`));
      expect(
        (yield* directory
          .create(registration("overflow@example.com", "overflow"))
          .pipe(Effect.flip)).message,
      ).toBe("Persona assignment is unavailable");
      expect(yield* directory.byHandle("overflow@example.com")).toBeUndefined();
      expect(yield* sql`SELECT id FROM user WHERE handle = 'overflow@example.com'`).toEqual([]);
      expect(
        yield* sql`SELECT session_id FROM usage_session WHERE session_id = 'overflow'`,
      ).toEqual([]);
      expect(
        yield* sql`SELECT handle FROM persona_assignment WHERE handle = 'overflow@example.com'`,
      ).toEqual([]);
      expect(yield* directory.all()).toHaveLength(5);
    }),
  ));
