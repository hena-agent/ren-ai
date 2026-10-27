import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const invitationSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE invitation_settings (id INTEGER PRIMARY KEY CHECK(id = 1), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)))`;
  // Automatic eligibility and actual basic issuance are distinct: manual grants also serve old Users.
  yield* sql`CREATE TABLE invitation_grant (handle TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
    automatic_seen INTEGER NOT NULL DEFAULT 0, basic_granted INTEGER NOT NULL DEFAULT 0, extra_count INTEGER NOT NULL DEFAULT 0)`;
  yield* sql`INSERT INTO invitation_grant (handle, created_at, automatic_seen) SELECT r.handle, MIN(s.created_at), 1
    FROM discovery_contact c JOIN discovery_registration r ON r.id = c.registration_id
    JOIN discovery_selection s ON s.request_id = c.selection_id GROUP BY r.handle`;
  yield* sql`INSERT OR IGNORE INTO invitation_grant (handle, created_at, automatic_seen) SELECT handle, joined_at, 1 FROM user WHERE joined_at IS NOT NULL`;
  yield* sql`CREATE TABLE invitation_delivery (id TEXT PRIMARY KEY, handle TEXT NOT NULL REFERENCES invitation_grant(handle),
    kind TEXT NOT NULL CHECK(kind IN ('basic','extra')), locale TEXT NOT NULL CHECK(locale IN ('ko','en','ja')),
    created_at INTEGER NOT NULL, request_id TEXT NOT NULL, body TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','sent','failed','uncertain','skipped')), guid TEXT)`;
  yield* sql`CREATE INDEX invitation_delivery_queue ON invitation_delivery(created_at, id) WHERE state = 'queued'`;
  yield* sql`CREATE TABLE invitation (token TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES invitation_grant(handle),
    delivery_id TEXT NOT NULL REFERENCES invitation_delivery(id), created_at INTEGER NOT NULL,
    redeemed_by TEXT UNIQUE, redeemed_at INTEGER, CHECK((redeemed_by IS NULL) = (redeemed_at IS NULL)))`;
  yield* sql`CREATE INDEX invitation_owner ON invitation(owner, created_at DESC, token)`;
  yield* sql`CREATE TABLE invitation_submission (registration_id TEXT PRIMARY KEY REFERENCES discovery_registration(id) ON DELETE CASCADE,
    token TEXT NOT NULL REFERENCES invitation(token), selected_notification_id INTEGER)`;
});
