import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const photoSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [definition] = yield* sql<{
    sql: string;
  }>`SELECT sql FROM sqlite_master WHERE name = 'send'`;
  const indexes = yield* sql<{ sql: string }>`SELECT sql FROM sqlite_master
    WHERE type = 'index' AND tbl_name = 'send' AND sql IS NOT NULL`;
  yield* sql.unsafe(
    definition!.sql
      .replace("CREATE TABLE send", "CREATE TABLE photo_send")
      .replace("'notice', 'text', 'tapback'", "'notice', 'text', 'tapback', 'photo'"),
  );
  yield* sql`INSERT INTO photo_send SELECT * FROM send`;
  yield* sql`DROP TABLE send`;
  yield* sql`ALTER TABLE photo_send RENAME TO send`;
  for (const index of indexes) yield* sql.unsafe(index.sql);
  yield* sql`CREATE INDEX send_photo ON send(conversation_id, content, state) WHERE kind = 'photo'`;
  yield* sql`CREATE INDEX send_photo_history ON send(conversation_id, recorded_at DESC)
    WHERE kind = 'photo' AND state IN ('sent','delivered')`;
  yield* sql`CREATE TABLE conversation_photo (
    id TEXT PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL, call_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','taken','declined')),
    reserved_at INTEGER NOT NULL, taken_at INTEGER, expires_at INTEGER, includes_me INTEGER NOT NULL,
    UNIQUE(session_id, call_id))`;
  yield* sql`CREATE INDEX photo_limit ON conversation_photo(conversation_id, state, taken_at, reserved_at)`;
  yield* sql`CREATE INDEX photo_pending ON conversation_photo(conversation_id, reserved_at) WHERE state = 'pending'`;
  // Independent of Conversation foreign keys: deleting SQL history cannot lose an R2 deletion.
  yield* sql`CREATE TABLE photo_object (photo_id TEXT PRIMARY KEY, due INTEGER)`;
  yield* sql`CREATE INDEX photo_cleanup ON photo_object(due, photo_id) WHERE due IS NOT NULL`;
  yield* sql`CREATE TRIGGER photo_remove BEFORE DELETE ON conversation_photo BEGIN
    UPDATE photo_object SET due = CASE WHEN OLD.state = 'pending' THEN due ELSE 0 END
      WHERE photo_id = OLD.id; END`;
  yield* sql`CREATE TABLE photo_setting(id INTEGER PRIMARY KEY CHECK(id = 1), enabled INTEGER NOT NULL)`;
  yield* sql`INSERT INTO photo_setting VALUES(1, 1)`;
});
