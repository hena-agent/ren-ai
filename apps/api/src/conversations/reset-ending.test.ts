import { Effect, Result } from "effect";
import { expect, test } from "vitest";
import { relationshipFixture } from "../../test/relationship.test-helper.ts";
import { withContactDatabase } from "../discovery/contact.test-helper.ts";
import { resets } from "./reset.ts";
import { conversationStatus } from "./status.ts";

test.each([
  ["ko", "요청에 따라 관계가 종료되었습니다"],
  ["en", "ended at your request"],
  ["ja", "ご希望により関係を終了しました"],
])(
  "a test-handle reset in %s preserves the relationship and queues only the service Notification",
  (locale, text) =>
    withContactDatabase(
      Effect.gen(function* () {
        const f = yield* relationshipFixture;
        yield* f.sql`INSERT INTO test_handle VALUES (${f.conversation.handle})`;
        yield* f.sql`UPDATE user SET locale = ${locale}`;
        const before = yield* f.sql`SELECT * FROM user`;
        const forgotten: string[] = [];
        const reset = yield* resets(
          f.app.directory,
          (id) =>
            Effect.sync(() => {
              forgotten.push(id);
            }),
          f.fake.messages,
        );
        const command = yield* f.fake.text(f.conversation.handle, " /RESET \n", Date.now());
        yield* reset.receive(command);
        expect(yield* f.app.directory.byHandle(command.handle)).toBeUndefined();
        expect(yield* f.sql`SELECT * FROM user`).toEqual(before);
        expect(yield* f.sql`SELECT session_id FROM conversation`).toEqual([
          { session_id: f.conversation.sessionID },
        ]);
        expect(
          yield* f.sql`SELECT initiator, farewell_pending, notice_pending, stopped_at FROM conversation_end`,
        ).toEqual([
          { initiator: "user", farewell_pending: 0, notice_pending: 1, stopped_at: null },
        ]);
        expect(yield* f.sql`SELECT name FROM application_work WHERE name = 'endings'`).toHaveLength(
          1,
        );
        const status = yield* conversationStatus(async () => []);
        expect((yield* status.detail(f.conversation.id))?.entry.endedBy).toBe("user");
        yield* f.app.endings.tick;
        yield* reset.receive(command);
        yield* f.app.endings.tick;
        expect(forgotten).toEqual([f.conversation.sessionID]);
        expect(f.fake.notifications).toHaveLength(1);
        expect(f.fake.notifications[0]?.text).toContain(text);
        expect(f.fake.notifications[0]?.text).toContain("#reselect=");
        expect(yield* f.fake.messages.recent(command.handle, 0)).toEqual([command]);
        expect(yield* f.sql`SELECT 1 FROM send`).toEqual([]);
      }),
    ),
);

test("reset admission and its durable cutoff roll back together, and stale commands cannot end the next relationship", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* relationshipFixture;
      yield* f.sql`INSERT INTO test_handle VALUES (${f.conversation.handle})`;
      const reset = yield* resets(f.app.directory, () => Effect.void, f.fake.messages);
      const command = yield* f.fake.text(f.conversation.handle, "/reset", Date.now());
      yield* f.sql`CREATE TRIGGER reject_reset BEFORE INSERT ON reset BEGIN SELECT RAISE(ABORT, 'private command'); END`;
      expect(Result.isFailure(yield* Effect.result(reset.receive(command)))).toBe(true);
      expect(yield* f.app.directory.byHandle(command.handle)).toEqual(f.conversation);
      expect(yield* f.sql`SELECT 1 FROM conversation_end`).toEqual([]);
      expect(yield* f.sql`SELECT 1 FROM reset`).toEqual([]);
      yield* f.sql`DROP TRIGGER reject_reset`;
      yield* reset.receive(command);
      yield* f.sql`INSERT INTO conversation(user_id, persona_id, session_id, started_at)
      SELECT id, 'harin', 'ses_next', ${command.createdAt + 100} FROM user`;
      const replacement = yield* resets(f.app.directory, () => Effect.void, f.fake.messages);
      yield* replacement.receive(command);
      yield* replacement.receive({
        ...command,
        id: command.id + 1,
        guid: "late-unseen-reset",
        createdAt: command.createdAt + 50,
      });
      expect((yield* f.app.directory.byHandle(command.handle))?.sessionID).toBe("ses_next");
      expect(yield* f.sql`SELECT 1 FROM conversation_end`).toHaveLength(1);
      yield* f.app.endings.tick;
      expect(f.fake.notifications).toEqual([]);
    }),
  ));
