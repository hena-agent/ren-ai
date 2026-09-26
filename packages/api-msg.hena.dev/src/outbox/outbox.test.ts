import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Random, Result } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { conversations } from "../conversations/conversations.ts";
import { migrate } from "../database.ts";
import { fakeGestures } from "../gestures/gestures.fake.ts";
import { fakeMessages } from "../messages/messages.fake.ts";
import { outbox } from "./outbox.ts";

test("SQLite migrates once and links each User, Conversation, session and send", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migrate;
      yield* migrate;
      const directory = yield* conversations;
      const input = {
        handle: "user@example.com",
        locale: "ko",
        consentVersion: "v1",
        consentLanguage: "ko",
        personaID: "persona1",
        sessionID: "session-1",
      };
      const conversation = yield* directory.create(input);
      expect(conversation).toEqual({
        id: 1,
        handle: input.handle,
        personaID: "persona1",
        sessionID: input.sessionID,
      });
      expect(yield* directory.byHandle(input.handle)).toEqual(conversation);
      expect(yield* directory.bySession(input.sessionID)).toEqual(conversation);
      expect(yield* directory.byHandle("stranger")).toBeUndefined();
      const duplicate = yield* Effect.result(
        directory.create({ ...input, sessionID: "session-2" }),
      );
      expect(Result.isFailure(duplicate)).toBe(true);
      expect((yield* sql`SELECT id FROM conversation`).length).toBe(1);
      expect((yield* sql`SELECT id FROM user`).length).toBe(1);
      const invalid = yield* Effect.result(
        sql`INSERT INTO conversation (user_id, persona_id, session_id, started_at) VALUES (999, 'persona1', 'invalid', 0)`,
      );
      expect(Result.isFailure(invalid)).toBe(true);
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  );
});

test("typing interruption, UI failure, uncertain send, and repeated call cannot escape the Outbox", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* migrate;
      const sql = yield* SqlClient.SqlClient;
      const directory = yield* conversations;
      const conversation = yield* directory.create({
        handle: "+821000000000",
        locale: "ko",
        consentVersion: "v1",
        consentLanguage: "ko",
        personaID: "persona1",
        sessionID: "s1",
      });
      const events: string[] = [];
      const ui = fakeGestures(events);
      const fake = fakeMessages(events);
      const sends = yield* outbox(fake.messages, ui.gestures, directory.active);
      ui.interrupt();
      expect(yield* sends.send(conversation, "interrupted", "call-1")).toBe(
        "not sent: a new message arrived",
      );
      expect((yield* sql`SELECT id FROM send`).length).toBe(0);
      expect(fake.bubbles).toEqual([]);
      expect(yield* ui.gestures.read(conversation.handle)).toBeUndefined();
      expect(yield* ui.gestures.react(conversation.handle, "like")).toBeUndefined();
      const failed = yield* outbox(
        { ...fake.messages, sendText: () => Effect.fail(new Error("imsg timed out")) },
        {
          ...ui.gestures,
          typing: () => Effect.fail(new Error("UI unavailable")),
        },
        directory.active,
      );
      expect(yield* failed.send(conversation, "in doubt", "call-2")).toBe(
        "not sent: send in doubt",
      );
      expect(yield* failed.send(conversation, "in doubt", "call-2")).toBe(
        "not sent: this call was already recorded",
      );
      expect(yield* sends.send(conversation, "must wait", "call-3")).toBe(
        "not sent: an earlier send is still in doubt",
      );
      expect(fake.bubbles).toEqual([]);
      const rows = yield* sql<{ state: string; content: string }>`SELECT state, content FROM send`;
      expect(rows).toEqual([{ state: "uncertain", content: "in doubt" }]);
      expect(events).toEqual(["typing"]);
    }).pipe(
      Random.withSeed("outbox"),
      Effect.provide(TestClock.layer()),
      Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
    ),
  );
});

test("typing time scales with text and is capped before each recorded send", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* migrate;
      const directory = yield* conversations;
      const conversation = yield* directory.create({
        handle: "long@example.com",
        locale: "ko",
        consentVersion: "v1",
        consentLanguage: "ko",
        personaID: "persona1",
        sessionID: "s-long",
      });
      const ui = fakeGestures();
      const fake = fakeMessages();
      const sends = yield* outbox(fake.messages, ui.gestures, directory.active);
      expect(yield* sends.send(conversation, "hello", "short")).toBe("sent");
      expect(yield* sends.send(conversation, "x".repeat(100), "long")).toBe("sent");
      expect(ui.typing[0]?.durationMillis).toBeGreaterThanOrEqual(2250);
      expect(ui.typing[0]?.durationMillis).toBeLessThan(3250);
      expect(ui.typing[1]?.durationMillis).toBe(15000);
      expect(fake.bubbles).toHaveLength(2);
    }).pipe(
      Random.withSeed("typing"),
      Effect.provide(TestClock.layer()),
      Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
    ),
  );
});
