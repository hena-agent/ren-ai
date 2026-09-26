import { Effect } from "effect";
import { Migrator, SqlClient } from "effect/unstable/sql";

export const migrate = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA foreign_keys = ON`;
  yield* Migrator.make({})({
    loader: Migrator.fromRecord({
      "001_conversations": Effect.gen(function* () {
        yield* sql`CREATE TABLE user (
          id INTEGER PRIMARY KEY,
          handle TEXT NOT NULL UNIQUE,
          locale TEXT NOT NULL,
          consent_version TEXT NOT NULL,
          consent_language TEXT NOT NULL,
          consent_at INTEGER NOT NULL,
          joined_at INTEGER,
          replied_at INTEGER
        )`;
        yield* sql`CREATE TABLE conversation (
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL UNIQUE REFERENCES user(id) ON DELETE CASCADE,
          persona_id TEXT NOT NULL,
          session_id TEXT NOT NULL UNIQUE,
          started_at INTEGER NOT NULL
        )`;
      }),
      "002_outbox": sql`CREATE TABLE send (
        id INTEGER PRIMARY KEY,
        handle TEXT NOT NULL,
        conversation_id INTEGER REFERENCES conversation(id) ON DELETE SET NULL,
        kind TEXT NOT NULL CHECK (kind IN ('notice', 'text', 'tapback')),
        content TEXT NOT NULL,
        tool_call_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('recorded', 'uncertain', 'sent', 'delivered', 'failed', 'not_sent')),
        guid TEXT,
        recorded_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (conversation_id, tool_call_id)
      )`,
      "003_intake": sql`CREATE TABLE bookmark (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        row_id INTEGER NOT NULL,
        date INTEGER NOT NULL
      )`,
      "004_intake_last": sql`CREATE TABLE intake_last (
        conversation_id INTEGER PRIMARY KEY REFERENCES conversation(id) ON DELETE CASCADE,
        date INTEGER NOT NULL
      )`,
      "005_intake_seen": sql`CREATE TABLE intake_seen (
        session_id TEXT NOT NULL,
        guid TEXT NOT NULL,
        PRIMARY KEY (session_id, guid)
      )`,
      "006_tapback_target": sql`ALTER TABLE send ADD COLUMN target_guid TEXT`,
      "007_blocked": sql`CREATE TABLE blocked (
        handle TEXT PRIMARY KEY,
        blocked_at INTEGER NOT NULL
      )`,
      "008_removal": sql`CREATE TABLE removal (
        handle TEXT PRIMARY KEY,
        session_id TEXT NOT NULL
      )`,
      "009_follow_up": sql`CREATE TABLE follow_up (
        conversation_id INTEGER PRIMARY KEY REFERENCES conversation(id) ON DELETE CASCADE,
        last_sent_at INTEGER NOT NULL,
        next_wake_at INTEGER,
        unanswered INTEGER NOT NULL DEFAULT 0,
        wake_pending INTEGER NOT NULL DEFAULT 0,
        followed_up INTEGER NOT NULL DEFAULT 0
      )`,
    }),
  });
});
