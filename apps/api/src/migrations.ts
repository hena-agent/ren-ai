import { Array, Effect } from "effect";
import { Migrator, SqlClient } from "effect/unstable/sql";

/** Cloudflare SQLite allows 100 bind variables; each migration receipt binds two. */
export const migrateBatches = (loader: Migrator.Loader<SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    const migrations = yield* loader;
    const sql = yield* SqlClient.SqlClient;
    const exists =
      yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`;
    if (exists.length) {
      const applied = yield* sql<{
        id: number;
        name: string;
      }>`SELECT migration_id AS id, name FROM effect_sql_migrations`;
      const names = new Map(applied.map((row) => [row.id, row.name]));
      for (const [id, name] of migrations) {
        const previous = names.get(id);
        if (previous !== undefined && previous !== name)
          return yield* Effect.fail(
            new Migrator.MigrationError({
              kind: "BadState",
              message: `Applied migration ${id}_${previous} conflicts with ${id}_${name}. Repair the database migration history before starting the API.`,
            }),
          );
      }
    }
    return yield* Effect.forEach(
      Array.chunksOf(migrations, 50),
      (batch) => Migrator.make({})({ loader: Effect.succeed(batch) }),
      { discard: true },
    );
  });
