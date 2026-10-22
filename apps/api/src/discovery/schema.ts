import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Preserve reservations and their IDs while replacing the exclusive-persona constraints. */
export const sharedAssignmentsSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE persona_assignment RENAME TO old_persona_assignment`;
  yield* sql`CREATE TABLE persona_assignment (persona_id TEXT NOT NULL, handle TEXT PRIMARY KEY NOT NULL)`;
  yield* sql`INSERT INTO persona_assignment SELECT persona_id, handle FROM old_persona_assignment`;
  yield* sql`DROP TABLE old_persona_assignment`;
  yield* sql`INSERT OR IGNORE INTO persona_assignment (persona_id, handle)
    SELECT c.persona_id, u.handle FROM conversation c JOIN user u ON u.id = c.user_id WHERE c.ended_at IS NULL`;
  yield* sql`INSERT OR IGNORE INTO persona_assignment (persona_id, handle)
    SELECT persona_id, handle FROM user WHERE persona_id IS NOT NULL`;
  yield* sql`CREATE INDEX assignment_persona ON persona_assignment(persona_id)`;
  yield* sql`ALTER TABLE discovery_contact RENAME TO old_discovery_contact`;
  yield* sql`CREATE TABLE discovery_contact (
    registration_id TEXT PRIMARY KEY REFERENCES discovery_registration(id) ON DELETE CASCADE,
    selection_id TEXT NOT NULL REFERENCES discovery_selection(request_id), persona_id TEXT NOT NULL,
    scheduled_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('scheduled','preparing','greeting','active','failed','review','blocked','unreachable')),
    session_id TEXT, started_at INTEGER, request_id TEXT NOT NULL,
    last_checked INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`INSERT INTO discovery_contact SELECT * FROM old_discovery_contact`;
  yield* sql`DROP TABLE old_discovery_contact`;
  yield* sql`CREATE INDEX contact_due ON discovery_contact(scheduled_at) WHERE state = 'scheduled'`;
  yield* sql`CREATE INDEX contact_inspection ON discovery_contact(last_checked, scheduled_at, registration_id)
    WHERE state IN ('scheduled','preparing','greeting','review')`;
  // No user FK: a relationship ending remains permanent through removal and test resets.
  yield* sql`CREATE TABLE persona_exclusion (handle TEXT NOT NULL, persona_id TEXT NOT NULL,
    PRIMARY KEY(handle, persona_id))`;
  yield* sql`INSERT OR IGNORE INTO persona_exclusion
    SELECT u.handle, c.persona_id FROM conversation c JOIN user u ON u.id = c.user_id WHERE c.ended_at IS NOT NULL`;
  yield* sql`CREATE TRIGGER preserve_relationship_ending AFTER UPDATE OF ended_at ON conversation
    WHEN NEW.ended_at IS NOT NULL BEGIN
      INSERT OR IGNORE INTO persona_exclusion (handle, persona_id)
      SELECT handle, NEW.persona_id FROM user WHERE id = NEW.user_id;
    END`;
});
