import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { SqlClient } from "effect/sql";
import { migrate } from "../database.ts";
import { contacts } from "./contacts.ts";

const contactProfiles = ["luna", "harin", "jiwoo"].map((id) => ({
  id,
  name: id,
  bio: "public",
  imageUrl: "https://images.test/photo.jpg",
}));
export const withContactDatabase = <A, E>(program: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(
    Effect.scoped(program).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  );
export const contactFixture = Effect.gen(function* () {
  yield* migrate;
  const sql = yield* SqlClient.SqlClient;
  const profiles = [...contactProfiles];
  const store = yield* contacts(async () => profiles);
  const register = (handle: string, likes = ["luna"]) =>
    Effect.gen(function* () {
      const id = randomUUID();
      // Selection fixtures represent registrations whose iMessage lookup succeeded.
      yield* sql`INSERT INTO discovery_registration (id, handle, locale, consent_version, created_at, imessage_status, imessage_checked_at)
        VALUES (${id}, ${handle}, 'ko', 'web-consent', 123, 'available', 123)`;
      for (const persona of likes)
        yield* sql`INSERT INTO discovery_like VALUES (${id}, ${persona})`;
      return id;
    });
  return { sql, store, register, profiles };
});

/** A first contact that is due now, as a Selection or a test start reserves it. */
export const dueContact = (handle: string, personaID: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const registration = randomUUID();
    yield* sql`INSERT INTO discovery_registration (id, handle, locale, consent_version, created_at) VALUES (${registration}, ${handle}, 'ko', 'v1', 1)`;
    yield* sql`INSERT INTO discovery_selection (request_id, requested, created_at) VALUES (${registration}, 1, 1)`;
    yield* sql`INSERT INTO persona_assignment VALUES (${personaID}, ${handle})`;
    yield* sql`INSERT INTO discovery_contact
      (registration_id, selection_id, persona_id, scheduled_at, state, request_id)
      VALUES (${registration}, ${registration}, ${personaID}, 0, 'scheduled', 'test')`;
  });
