import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { registrationHistorySchema } from "../src/conversations/schema.ts";

/** Run the deployed predecessor shape against the caller's actual SQLite adapter. */
export const registrationSchemaProbe = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA foreign_keys = ON`;
  yield* sql`CREATE TABLE discovery_registration (id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE,
    locale TEXT NOT NULL, consent_version TEXT NOT NULL, created_at INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE discovery_like (registration_id TEXT NOT NULL REFERENCES discovery_registration(id) ON DELETE CASCADE,
    persona_id TEXT NOT NULL, PRIMARY KEY (registration_id, persona_id))`;
  yield* sql`CREATE TABLE discovery_language (registration_id TEXT PRIMARY KEY REFERENCES discovery_registration(id) ON DELETE CASCADE,
    conversation_language TEXT NOT NULL)`;
  yield* sql`CREATE TABLE discovery_contact (registration_id TEXT PRIMARY KEY REFERENCES discovery_registration(id) ON DELETE CASCADE,
    persona_id TEXT NOT NULL, selection_id TEXT NOT NULL, state TEXT NOT NULL)`;
  yield* sql`INSERT INTO discovery_registration VALUES ('original', 'alma@example.com', 'ko', 'approved', 100)`;
  yield* sql`INSERT INTO discovery_like VALUES ('original', 'seoyul')`;
  yield* sql`INSERT INTO discovery_language VALUES ('original', 'ko')`;
  yield* sql`INSERT INTO discovery_contact VALUES ('original', 'seoyul', 'selection-original', 'active')`;
  yield* registrationHistorySchema.pipe(sql.withTransaction);
  yield* sql`UPDATE discovery_registration SET archived_at = 200 WHERE id = 'original'`;
  yield* sql`INSERT INTO discovery_registration (id, handle, locale, consent_version, created_at)
    VALUES ('next', 'alma@example.com', 'ko', 'approved-next', 201)`;
  return {
    registrations:
      yield* sql`SELECT id, archived_at FROM discovery_registration ORDER BY created_at`,
    likes: yield* sql`SELECT * FROM discovery_like`,
    languages: yield* sql`SELECT * FROM discovery_language`,
    contacts: yield* sql`SELECT * FROM discovery_contact`,
    violations: yield* sql`PRAGMA foreign_key_check`,
  };
});
