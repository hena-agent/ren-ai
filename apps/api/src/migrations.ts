import { Array, Effect } from "effect";
import { Migrator, SqlClient } from "effect/unstable/sql";

/** Cloudflare SQLite allows 100 bind variables; each migration receipt binds two. */
export const migrateBatches = (loader: Migrator.Loader<SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    const migrations = yield* loader;
    yield* Effect.forEach(
      Array.chunksOf(migrations, 50),
      (batch) => Migrator.make({})({ loader: Effect.succeed(batch) }),
      { discard: true },
    );
  });
