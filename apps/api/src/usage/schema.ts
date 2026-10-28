import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** No foreign keys to live conversations: resets and session replacement retain usage. */
export const usageSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE conversation ADD COLUMN usage_key TEXT`;
  yield* sql`CREATE TABLE usage_session (
    session_id TEXT PRIMARY KEY, conversation_id INTEGER NOT NULL, conversation_key TEXT NOT NULL,
    persona_id TEXT NOT NULL, message_count INTEGER NOT NULL DEFAULT 0,
    synced_at INTEGER, unavailable INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE TABLE usage_turn (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
    outcome TEXT NOT NULL DEFAULT 'running'
  )`;
  yield* sql`CREATE TABLE usage_entry (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT, source TEXT NOT NULL,
    message_id TEXT, provider_id TEXT, model_id TEXT, variant TEXT,
    started_at INTEGER NOT NULL, ended_at INTEGER, outcome TEXT NOT NULL,
    input REAL, output REAL, reasoning REAL, cache_read REAL, cache_write REAL, cost REAL,
    finish TEXT, error_type TEXT, upstream_status INTEGER
  )`;
  yield* sql`CREATE INDEX usage_entry_session ON usage_entry(session_id, started_at, id)`;
  yield* sql`CREATE INDEX usage_turn_session ON usage_turn(session_id, started_at, id)`;
  yield* bindUsageSessions(sql);
});

export const bindUsageSessions = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    // SQLite row IDs and test clocks can both repeat after reset; preserve an immutable binding.
    yield* sql`UPDATE conversation SET usage_key = lower(hex(randomblob(16))) WHERE usage_key IS NULL`;
    yield* sql`INSERT OR IGNORE INTO usage_session (session_id, conversation_id, conversation_key, persona_id)
    SELECT session_id, id, usage_key, persona_id FROM conversation`;
  });
