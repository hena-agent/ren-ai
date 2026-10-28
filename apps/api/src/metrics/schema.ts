import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { counterSchema } from "./totals.ts";
import { discordSchema } from "./discord.ts";

export const metricsSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* counterSchema;
  yield* discordSchema;
  yield* sql`ALTER TABLE discovery_registration ADD COLUMN metric_source TEXT NOT NULL DEFAULT 'unknown'`;
  yield* sql`ALTER TABLE discovery_registration ADD COLUMN metric_country TEXT NOT NULL DEFAULT 'unknown'`;
  yield* sql`ALTER TABLE discovery_registration ADD COLUMN metric_joining TEXT NOT NULL DEFAULT 'unknown'`;
  yield* sql`ALTER TABLE conversation ADD COLUMN metric_greeting_at INTEGER`;
  yield* sql`ALTER TABLE conversation ADD COLUMN metric_active_day TEXT`;
  yield* sql`ALTER TABLE conversation ADD COLUMN metric_flags INTEGER NOT NULL DEFAULT 0`;
  // Existing Greetings are not new rollout events or new Retention cohorts.
  yield* sql`UPDATE conversation SET metric_flags = 1 WHERE EXISTS (SELECT 1 FROM send WHERE conversation_id = conversation.id AND kind = 'text' AND state IN ('sent', 'delivered'))`;
  // Receipts are owned by live records, not anonymous totals; deleting an owner erases them.
  yield* sql`CREATE TABLE metric_receipt (
    registration_id TEXT NOT NULL REFERENCES discovery_registration(id) ON DELETE CASCADE,
    conversation_id INTEGER REFERENCES conversation(id) ON DELETE CASCADE,
    step TEXT NOT NULL, day TEXT NOT NULL, dimensions TEXT NOT NULL,
    PRIMARY KEY(registration_id, step, day)) WITHOUT ROWID`;
  yield* sql`CREATE INDEX metric_receipt_conversation ON metric_receipt(conversation_id)`;
  yield* sql`ALTER TABLE usage_session ADD COLUMN metric_excluded INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE usage_session ADD COLUMN metric_excluded_until INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE usage_entry ADD COLUMN metric_excluded INTEGER NOT NULL DEFAULT 0`;
  yield* sql`UPDATE usage_session SET metric_excluded = 1 WHERE conversation_key IN (
    SELECT c.usage_key FROM conversation c JOIN user u ON u.id = c.user_id JOIN test_handle t ON t.handle = u.handle)`;
  yield* sql`CREATE INDEX usage_entry_date ON usage_entry(started_at, session_id)`;
  yield* sql`CREATE TRIGGER usage_test_exclusion AFTER INSERT ON usage_session BEGIN
    UPDATE usage_session SET metric_excluded = 1 WHERE session_id = NEW.session_id AND EXISTS (
      SELECT 1 FROM conversation c JOIN user u ON u.id = c.user_id JOIN test_handle t ON t.handle = u.handle WHERE c.usage_key = NEW.conversation_key);
    END`;
  yield* sql`CREATE TRIGGER usage_entry_test_exclusion AFTER INSERT ON usage_entry BEGIN
    UPDATE usage_entry SET metric_excluded = 1 WHERE id = NEW.id AND EXISTS (
      SELECT 1 FROM usage_session s WHERE s.session_id = NEW.session_id AND (s.metric_excluded = 1 OR NEW.started_at <= s.metric_excluded_until));
    END`;
  yield* sql`CREATE TABLE metric_join_failure(id INTEGER PRIMARY KEY, at INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE metric_epoch (at INTEGER NOT NULL)`;
  yield* sql`INSERT INTO metric_epoch VALUES (CAST(unixepoch('subsec') * 1000 AS INTEGER))`;
});
