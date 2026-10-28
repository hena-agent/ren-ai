import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { expect, test } from "vitest";
import { withContactDatabase } from "./contact.test-helper.ts";
import { sharedAssignmentsSchema } from "./schema.ts";
import { claimPersona } from "./assignment.ts";

test("assignment migration preserves reservation IDs, pending sessions, active relationships and foreign keys", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* sql`CREATE TABLE user(id INTEGER PRIMARY KEY, handle TEXT NOT NULL UNIQUE, persona_id TEXT)`;
      yield* sql`CREATE TABLE conversation(id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES user(id) ON DELETE CASCADE,
      persona_id TEXT NOT NULL, session_id TEXT NOT NULL, ended_at INTEGER)`;
      yield* sql`CREATE TABLE persona_assignment(persona_id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE)`;
      yield* sql`CREATE TABLE discovery_registration(id TEXT PRIMARY KEY)`;
      yield* sql`CREATE TABLE discovery_selection(request_id TEXT PRIMARY KEY)`;
      yield* sql`CREATE TABLE discovery_contact(
      registration_id TEXT PRIMARY KEY REFERENCES discovery_registration(id) ON DELETE CASCADE,
      selection_id TEXT NOT NULL REFERENCES discovery_selection(request_id), persona_id TEXT NOT NULL UNIQUE,
      scheduled_at INTEGER NOT NULL, state TEXT NOT NULL, session_id TEXT, started_at INTEGER, request_id TEXT NOT NULL,
      last_checked INTEGER NOT NULL DEFAULT 0)`;
      yield* sql`CREATE INDEX contact_due ON discovery_contact(scheduled_at) WHERE state = 'scheduled'`;
      yield* sql`CREATE INDEX contact_inspection ON discovery_contact(last_checked, scheduled_at, registration_id)
        WHERE state IN ('scheduled','preparing','greeting','review')`;
      yield* sql`INSERT INTO user VALUES (11, 'active', 'luna'), (12, 'ended', NULL), (13, 'pending', 'jiwoo')`;
      yield* sql`INSERT INTO conversation VALUES (21, 11, 'luna', 'ses_active', NULL), (22, 12, 'luna', 'ses_ended', 20)`;
      yield* sql`INSERT INTO persona_assignment VALUES ('harin', 'uncertain')`;
      yield* sql`INSERT INTO discovery_registration VALUES ('registration')`;
      yield* sql`INSERT INTO discovery_selection VALUES ('selection')`;
      yield* sql`INSERT INTO discovery_contact VALUES ('registration', 'selection', 'harin', 30, 'review', 'ses_prepared', NULL, 'request', 25)`;
      const reservations = yield* sql`SELECT * FROM discovery_contact`;
      const conversations = yield* sql`SELECT * FROM conversation`;
      yield* sharedAssignmentsSchema.pipe(sql.withTransaction);
      expect(yield* sql`SELECT * FROM discovery_contact`).toEqual(reservations);
      expect(yield* sql`SELECT * FROM conversation`).toEqual(conversations);
      expect(yield* sql`SELECT * FROM persona_assignment ORDER BY handle`).toEqual([
        { persona_id: "luna", handle: "active" },
        { persona_id: "jiwoo", handle: "pending" },
        { persona_id: "harin", handle: "uncertain" },
      ]);
      expect(yield* claimPersona("luna", "ended")).toBe(false);
      yield* sql`UPDATE conversation SET ended_at = 40 WHERE id = 21`;
      yield* sql`DELETE FROM persona_assignment WHERE handle = 'active'`;
      yield* sql`DELETE FROM user WHERE id IN (11,12)`;
      expect(yield* claimPersona("luna", "active")).toBe(false);
      expect(yield* claimPersona("luna", "ended")).toBe(false);
      expect(yield* claimPersona("luna", "newcomer")).toBe(true);
      yield* sql`INSERT INTO discovery_registration VALUES ('second')`;
      yield* sql`INSERT INTO discovery_contact VALUES ('second', 'selection', 'harin', 40, 'scheduled', NULL, NULL, 'second-request', 0)`;
      expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
      yield* sql`DELETE FROM discovery_registration WHERE id = 'registration'`;
      expect(yield* sql`SELECT registration_id FROM discovery_contact`).toEqual([
        { registration_id: "second" },
      ]);
      const plan = yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM persona_assignment WHERE persona_id = 'luna'`;
      expect(plan.some((row) => row.detail.includes("assignment_persona"))).toBe(true);
      const inspection = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN SELECT registration_id
        FROM discovery_contact WHERE state IN ('scheduled','preparing','greeting','review')
        ORDER BY last_checked, scheduled_at, registration_id LIMIT 10`;
      expect(inspection.some((row) => row.detail.includes("contact_inspection"))).toBe(true);
    }),
  );
});
