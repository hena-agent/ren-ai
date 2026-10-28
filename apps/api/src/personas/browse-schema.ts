import { Effect } from "effect";
import { SqlClient } from "effect/sql";

export const browseSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE browse_snapshot (revision TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)`;
  yield* sql`CREATE INDEX browse_snapshot_expiry ON browse_snapshot(expires_at, revision)`;
  yield* sql`CREATE TABLE browse_persona (
    revision TEXT NOT NULL, id TEXT NOT NULL, random_key TEXT NOT NULL,
    ko INTEGER NOT NULL, en INTEGER NOT NULL, ja INTEGER NOT NULL,
    PRIMARY KEY(revision, id))`;
  for (const locale of ["ko", "en", "ja"])
    yield* sql`CREATE INDEX ${sql(`browse_${locale}`)} ON browse_persona(revision, ${sql(locale)}, random_key, id)`;
  yield* sql`CREATE TABLE browse_live (id TEXT PRIMARY KEY, payload TEXT NOT NULL)`;
  yield* sql`ALTER TABLE public_catalog ADD COLUMN revision TEXT`;
  yield* sql`UPDATE public_catalog SET payload = NULL, loaded_at = 0, retry_at = 0`;
});
