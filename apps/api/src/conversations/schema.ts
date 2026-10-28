import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { rebuildHistoryParent } from "./schema-rebuild.ts";

/** Runs in the migrator's transaction. Rebuild the parent without triggering child cascades. */
export const relationshipSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* rebuildHistoryParent("conversation", "user_id INTEGER NOT NULL UNIQUE", "ended_at", [
    "send",
    "follow_up",
  ]);
  yield* sql`ALTER TABLE conversation ADD COLUMN first_received_at INTEGER`;
  yield* sql`UPDATE conversation SET first_received_at = (SELECT replied_at FROM user WHERE user.id = conversation.user_id)`;
  yield* sql`CREATE UNIQUE INDEX active_conversation ON conversation(user_id) WHERE ended_at IS NULL`;
  yield* sql`CREATE TABLE conversation_end (
    conversation_id INTEGER PRIMARY KEY REFERENCES conversation(id) ON DELETE CASCADE,
    call_id TEXT NOT NULL,
    farewell TEXT NOT NULL,
    notice TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    consumed_at INTEGER,
    registration_id TEXT,
    stopped_at INTEGER,
    stop_checked INTEGER NOT NULL DEFAULT 0,
    farewell_pending INTEGER NOT NULL DEFAULT 1,
    notice_pending INTEGER NOT NULL DEFAULT 1,
    farewell_attempt INTEGER NOT NULL DEFAULT 0,
    notice_attempt INTEGER NOT NULL DEFAULT 0,
    last_checked INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE TABLE conversation_recovery (
    request_id TEXT PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    action TEXT NOT NULL, created_at INTEGER NOT NULL
  )`;
});

export const registrationHistorySchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* rebuildHistoryParent(
    "discovery_registration",
    "handle TEXT NOT NULL UNIQUE",
    "archived_at",
    ["discovery_like", "discovery_language", "discovery_contact"],
  );
  yield* sql`CREATE UNIQUE INDEX current_registration ON discovery_registration(handle) WHERE archived_at IS NULL`;
});
