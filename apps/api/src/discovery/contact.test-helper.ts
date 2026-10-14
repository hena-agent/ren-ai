import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { SqlClient } from "effect/unstable/sql";
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
      yield* sql`INSERT INTO discovery_registration VALUES (${id}, ${handle}, 'ko', 'web-consent', 123)`;
      for (const persona of likes)
        yield* sql`INSERT INTO discovery_like VALUES (${id}, ${persona})`;
      return id;
    });
  return { sql, store, register, profiles };
});
