import { Effect } from "effect";
import { Migrator, SqlClient } from "effect/unstable/sql";
import { relationshipSchema, registrationHistorySchema } from "./conversations/schema.ts";
import { usageSchema } from "./usage/schema.ts";

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
      "009_send_reconciliation": sql`ALTER TABLE send ADD COLUMN late INTEGER NOT NULL DEFAULT 0`,
      "010_send_notice": sql`ALTER TABLE send ADD COLUMN notification_pending INTEGER NOT NULL DEFAULT 0`,
      "011_waitlist": sql`CREATE TABLE waitlist (
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL,
        locale TEXT NOT NULL,
        answer TEXT NOT NULL CHECK (answer IN ('no_imessage', 'unknown', 'full')),
        created_at INTEGER NOT NULL
      )`,
      "012_follow_up": sql`CREATE TABLE follow_up (
        conversation_id INTEGER PRIMARY KEY REFERENCES conversation(id) ON DELETE CASCADE,
        last_sent_at INTEGER NOT NULL,
        next_wake_at INTEGER,
        unanswered INTEGER NOT NULL DEFAULT 0,
        wake_pending INTEGER NOT NULL DEFAULT 0,
        followed_up INTEGER NOT NULL DEFAULT 0
      )`,
      "013_rebuilding": sql`ALTER TABLE conversation ADD COLUMN rebuilding INTEGER NOT NULL DEFAULT 0`,
      "014_fold_intake_last": Effect.gen(function* () {
        yield* sql`ALTER TABLE conversation ADD COLUMN last_received_at INTEGER`;
        yield* sql`UPDATE conversation SET last_received_at =
          (SELECT date FROM intake_last WHERE conversation_id = conversation.id)`;
        yield* sql`DROP TABLE intake_last`;
      }),
      "015_resets": Effect.gen(function* () {
        yield* sql`CREATE TABLE test_handle (handle TEXT PRIMARY KEY)`;
        yield* sql`CREATE TABLE retained_session (
          session_id TEXT PRIMARY KEY, handle TEXT NOT NULL, title TEXT NOT NULL
        )`;
        yield* sql`CREATE TABLE reset (
          guid TEXT PRIMARY KEY, handle TEXT NOT NULL, row_id INTEGER NOT NULL,
          date INTEGER NOT NULL, session_id TEXT NOT NULL, complete INTEGER NOT NULL DEFAULT 0
        )`;
        yield* sql`ALTER TABLE conversation ADD COLUMN reset_guid TEXT`;
        yield* sql`ALTER TABLE removal RENAME TO old_removal`;
        yield* sql`CREATE TABLE removal (handle TEXT NOT NULL, session_id TEXT PRIMARY KEY)`;
        yield* sql`INSERT INTO removal SELECT handle, session_id FROM old_removal`;
        yield* sql`DROP TABLE old_removal`;
      }),
      "016_reset_onboarding": Effect.gen(function* () {
        yield* sql`ALTER TABLE reset ADD COLUMN notice_id INTEGER NOT NULL DEFAULT 0`;
        yield* sql`UPDATE reset SET notice_id = COALESCE((SELECT MAX(send.id) FROM send
          WHERE send.handle = reset.handle AND send.kind = 'notice' AND send.recorded_at <= reset.date), 0)`;
      }),
      "017_selected_persona": sql`ALTER TABLE user ADD COLUMN persona_id TEXT`,
      "018_discovery": Effect.gen(function* () {
        yield* sql`CREATE TABLE discovery_registration (
          id TEXT PRIMARY KEY,
          handle TEXT NOT NULL UNIQUE,
          locale TEXT NOT NULL,
          consent_version TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )`;
        yield* sql`CREATE TABLE discovery_like (
          registration_id TEXT NOT NULL REFERENCES discovery_registration(id) ON DELETE CASCADE,
          persona_id TEXT NOT NULL,
          PRIMARY KEY (registration_id, persona_id)
        )`;
      }),
      "019_discovery_contacts": Effect.gen(function* () {
        yield* sql`CREATE TABLE persona_assignment (
          persona_id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE
        )`;
        yield* sql`CREATE TABLE discovery_selection (
          request_id TEXT PRIMARY KEY, requested INTEGER NOT NULL, created_at INTEGER NOT NULL
        )`;
        yield* sql`CREATE TABLE discovery_contact (
          registration_id TEXT PRIMARY KEY REFERENCES discovery_registration(id) ON DELETE CASCADE,
          selection_id TEXT NOT NULL REFERENCES discovery_selection(request_id),
          persona_id TEXT NOT NULL UNIQUE,
          scheduled_at INTEGER NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('scheduled','preparing','greeting','active','failed','review','blocked','unreachable')),
          session_id TEXT,
          started_at INTEGER,
          request_id TEXT NOT NULL
        )`;
      }),
      "020_retire_legacy_onboarding": Effect.gen(function* () {
        yield* sql`DROP TABLE waitlist`;
        yield* sql`ALTER TABLE reset DROP COLUMN notice_id`;
        yield* sql`DELETE FROM send WHERE kind = 'notice'`;
        yield* sql`DELETE FROM user WHERE joined_at IS NULL`;
      }),
      "021_failed_turns": sql`CREATE TABLE failed_turn (
        session_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        failures INTEGER NOT NULL,
        quota INTEGER NOT NULL,
        failed_at INTEGER NOT NULL,
        retry_at INTEGER NOT NULL,
        last_retry_at INTEGER NOT NULL DEFAULT 0,
        review INTEGER NOT NULL DEFAULT 0,
        provider_alerted INTEGER NOT NULL DEFAULT 0
      )`,
      "022_discovery_language": sql`CREATE TABLE discovery_language (
        registration_id TEXT PRIMARY KEY REFERENCES discovery_registration(id) ON DELETE CASCADE,
        conversation_language TEXT NOT NULL
      )`,
      "023_recovery_scan": sql`CREATE TABLE recovery_scan (
        id INTEGER PRIMARY KEY CHECK(id = 1), conversation_id INTEGER NOT NULL
      )`,
      "024_intake_pending": Effect.gen(function* () {
        yield* sql`CREATE TABLE intake_pending (
          id INTEGER PRIMARY KEY, guid TEXT NOT NULL UNIQUE, handle TEXT NOT NULL,
          payload TEXT NOT NULL, retry_at INTEGER NOT NULL DEFAULT 0
        )`;
        yield* sql`CREATE INDEX intake_pending_handle ON intake_pending(handle, id)`;
      }),
      "025_relationship_endings": relationshipSchema,
      "026_registration_history": registrationHistorySchema,
      "027_discovery_profile": sql`CREATE TABLE discovery_profile (
        registration_id TEXT PRIMARY KEY REFERENCES discovery_registration(id) ON DELETE CASCADE,
        name TEXT, age INTEGER, gender TEXT
      )`,
      "028_reply_arrivals": sql`CREATE TABLE reply_arrival (
        session_id TEXT NOT NULL, message_id TEXT NOT NULL, quiet_until INTEGER NOT NULL,
        seen INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (session_id, message_id)
      )`,
      "029_edit_observations": sql`CREATE TABLE intake_edit (
        session_id TEXT NOT NULL, guid TEXT NOT NULL, text TEXT NOT NULL,
        revision INTEGER NOT NULL, PRIMARY KEY (session_id, guid)
      )`,
      "030_conversation_usage": usageSchema.pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      "031_event_scheduling": Effect.gen(function* () {
        yield* sql`CREATE TABLE application_work (name TEXT PRIMARY KEY, due INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0)`;
        yield* sql`CREATE TABLE application_clock (name TEXT PRIMARY KEY, at INTEGER NOT NULL)`;
        yield* sql`ALTER TABLE intake_edit ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0`;
        yield* sql`CREATE INDEX intake_edit_expiry ON intake_edit(created_at)`;
        yield* sql`CREATE INDEX contact_due ON discovery_contact(scheduled_at) WHERE state = 'scheduled'`;
        yield* sql`CREATE INDEX follow_up_due ON follow_up(next_wake_at) WHERE next_wake_at IS NOT NULL`;
        yield* sql`CREATE INDEX failure_due ON failed_turn(retry_at) WHERE review = 0`;
        yield* sql`CREATE INDEX intake_due ON intake_pending(retry_at)`;
        yield* sql`ALTER TABLE retained_session ADD COLUMN stopped INTEGER NOT NULL DEFAULT 0`;
        yield* sql`CREATE TABLE context_seen (session_id TEXT PRIMARY KEY, guid TEXT)`;
        yield* sql`CREATE TABLE runtime_catalog (id INTEGER PRIMARY KEY CHECK(id=1), revision TEXT NOT NULL, payload TEXT NOT NULL, synced TEXT)`;
        yield* sql`CREATE TABLE discovery_attempt (ip TEXT NOT NULL, at INTEGER NOT NULL)`;
        yield* sql`CREATE INDEX discovery_attempt_ip ON discovery_attempt(ip, at)`;
        yield* sql`CREATE INDEX discovery_attempt_expiry ON discovery_attempt(at)`;
      }),
      "032_usage_checkpoints": Effect.gen(function* () {
        yield* sql`ALTER TABLE usage_session ADD COLUMN fingerprint TEXT`;
        yield* sql`ALTER TABLE usage_session ADD COLUMN last_idle TEXT`;
        yield* sql`ALTER TABLE usage_session ADD COLUMN next_check_at INTEGER DEFAULT 0`;
        yield* sql`CREATE INDEX usage_session_due ON usage_session(next_check_at, session_id)`;
        yield* sql`CREATE INDEX usage_entry_turn ON usage_entry(turn_id, outcome)`;
      }),
    }),
  });
});
