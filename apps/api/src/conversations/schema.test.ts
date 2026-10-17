import { Effect, Result } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { withContactDatabase } from "../discovery/contact.test-helper.ts";
import { relationshipSchema } from "./schema.ts";

const predecessor = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA foreign_keys = ON`;
  yield* sql`CREATE TABLE user(id INTEGER PRIMARY KEY, handle TEXT NOT NULL UNIQUE, replied_at INTEGER)`;
  yield* sql`CREATE TABLE conversation (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL UNIQUE REFERENCES user(id) ON DELETE CASCADE,
    persona_id TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE, started_at INTEGER NOT NULL,
    rebuilding INTEGER NOT NULL DEFAULT 0, last_received_at INTEGER, reset_guid TEXT)`;
  yield* sql`CREATE TABLE send(id INTEGER PRIMARY KEY, conversation_id INTEGER REFERENCES conversation(id) ON DELETE SET NULL,
    content TEXT NOT NULL, state TEXT NOT NULL)`;
  yield* sql`CREATE TABLE follow_up(conversation_id INTEGER PRIMARY KEY REFERENCES conversation(id) ON DELETE CASCADE,
    next_wake_at INTEGER, unanswered INTEGER NOT NULL)`;
  yield* sql`INSERT INTO user VALUES (7, 'private@example.com', 120)`;
  yield* sql`INSERT INTO conversation VALUES (19, 7, 'seoyul', 'ses_original', 100, 0, 150, NULL)`;
  yield* sql`INSERT INTO send VALUES (31, 19, 'original private text', 'uncertain')`;
  yield* sql`INSERT INTO follow_up VALUES (19, 300, 2)`;
  return sql;
});

test("relationship schema preserves existing identities, sends, pending work and foreign keys while allowing a new relationship", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const sql = yield* predecessor;
      yield* relationshipSchema.pipe(sql.withTransaction);
      expect(yield* sql`SELECT * FROM user`).toEqual([
        { id: 7, handle: "private@example.com", replied_at: 120 },
      ]);
      expect(yield* sql`SELECT first_received_at FROM conversation`).toEqual([
        { first_received_at: 120 },
      ]);
      expect(yield* sql`SELECT * FROM send`).toEqual([
        { id: 31, conversation_id: 19, content: "original private text", state: "uncertain" },
      ]);
      expect(yield* sql`SELECT * FROM follow_up`).toEqual([
        { conversation_id: 19, next_wake_at: 300, unanswered: 2 },
      ]);
      expect(
        yield* sql`SELECT id, session_id, started_at, last_received_at, ended_at FROM conversation`,
      ).toEqual([
        {
          id: 19,
          session_id: "ses_original",
          started_at: 100,
          last_received_at: 150,
          ended_at: null,
        },
      ]);
      expect(
        Result.isFailure(
          yield* Effect.result(
            sql`INSERT INTO conversation (user_id, persona_id, session_id, started_at) VALUES (7, 'harin', 'ses_early', 200)`,
          ),
        ),
      ).toBe(true);
      yield* sql`UPDATE conversation SET ended_at = 200 WHERE id = 19`;
      yield* sql`INSERT INTO conversation (user_id, persona_id, session_id, started_at) VALUES (7, 'harin', 'ses_new', 201)`;
      expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
      yield* sql`DELETE FROM user WHERE id = 7`;
      expect(yield* sql`SELECT * FROM follow_up`).toEqual([]);
      expect(yield* sql`SELECT conversation_id FROM send`).toEqual([{ conversation_id: null }]);
    }),
  );
});

test("an interrupted schema change rolls back without losing original data or leaving staging tables", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const sql = yield* predecessor;
      yield* sql`CREATE TABLE conversation_end(id INTEGER)`;
      expect(
        Result.isFailure(yield* Effect.result(relationshipSchema.pipe(sql.withTransaction))),
      ).toBe(true);
      expect(yield* sql`SELECT session_id FROM conversation`).toEqual([
        { session_id: "ses_original" },
      ]);
      expect(yield* sql`SELECT content, conversation_id FROM send`).toEqual([
        { content: "original private text", conversation_id: 19 },
      ]);
      expect(yield* sql`SELECT unanswered FROM follow_up`).toEqual([{ unanswered: 2 }]);
      expect(yield* sql`SELECT name FROM sqlite_master WHERE name LIKE 'history_%'`).toEqual([]);
      expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
    }),
  );
});

test("a missing required child table aborts history conversion before replacing the parent", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const sql = yield* predecessor;
      yield* sql`DROP TABLE follow_up`;
      const result = yield* Effect.result(relationshipSchema.pipe(sql.withTransaction));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure.message).toBe("History child table missing");
      expect(yield* sql`SELECT session_id FROM conversation`).toEqual([
        { session_id: "ses_original" },
      ]);
      expect(yield* sql`SELECT content FROM send`).toEqual([{ content: "original private text" }]);
    }),
  );
});

test("unexpected predecessor schemas and pre-existing foreign key violations abort without partial changes", async () => {
  for (const definition of [
    'CREATE TABLE "conversation" (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL UNIQUE)',
    "CREATE TABLE conversation (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL)",
  ]) {
    await withContactDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(definition);
        expect(
          Result.isFailure(yield* Effect.result(relationshipSchema.pipe(sql.withTransaction))),
        ).toBe(true);
        expect(yield* sql`SELECT name FROM sqlite_master WHERE name LIKE 'history_%'`).toEqual([]);
      }),
    );
  }
  await withContactDatabase(
    Effect.gen(function* () {
      const sql = yield* predecessor;
      yield* sql`PRAGMA foreign_keys = OFF`;
      yield* sql`CREATE TABLE broken_reference (user_id INTEGER REFERENCES user(id))`;
      yield* sql`INSERT INTO broken_reference VALUES (999)`;
      yield* sql`PRAGMA foreign_keys = ON`;
      const result = yield* Effect.result(relationshipSchema.pipe(sql.withTransaction));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure.message).toBe("History schema foreign key validation failed");
      expect(yield* sql`SELECT session_id FROM conversation`).toEqual([
        { session_id: "ses_original" },
      ]);
    }),
  );
});
