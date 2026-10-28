import { Effect, Exit } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import { expect, test } from "vitest";
import { withContactDatabase } from "./discovery/contact.test-helper.ts";
import { migrateBatches } from "./migrations.ts";
import { migrate } from "./database.ts";

test("bounded migration batches roll back a failed batch and resume without repeating completed effects", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE migration_probe (id INTEGER PRIMARY KEY)`;
      const definitions = Object.fromEntries(
        Array.from({ length: 102 }, (_, index) => {
          const id = index + 100;
          return [`${id}_probe`, sql`INSERT INTO migration_probe VALUES (${id})`];
        }),
      );
      const failed = yield* migrateBatches(
        Migrator.fromRecord({
          ...definitions,
          "199_probe": Effect.fail(new Error("deliberate migration failure")),
        }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(failed)).toBe(true);
      expect(yield* sql`SELECT COUNT(*) AS count FROM migration_probe`).toEqual([{ count: 50 }]);
      yield* migrateBatches(Migrator.fromRecord(definitions));
      expect(yield* sql`SELECT COUNT(*) AS count FROM migration_probe`).toEqual([{ count: 102 }]);
      yield* migrateBatches(Migrator.fromRecord(definitions));
      expect(yield* sql`SELECT COUNT(*) AS count FROM migration_probe`).toEqual([{ count: 102 }]);
    }),
  );
});

test("the real registry rejects a reused migration number before running new schema changes", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migrate;
      yield* sql`UPDATE effect_sql_migrations SET name = 'invitations' WHERE migration_id = 53`;
      const failed = yield* migrate.pipe(Effect.exit);
      expect(Exit.isFailure(failed)).toBe(true);
      expect(Exit.isFailure(failed) ? String(failed.cause) : "").toContain("53_invitations");
      expect(yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 53`).toEqual([
        { name: "invitations" },
      ]);
      yield* sql`UPDATE effect_sql_migrations SET name = 'conversation_image_style' WHERE migration_id = 53`;
      yield* migrate;
      expect(
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 55 ORDER BY migration_id`,
      ).toEqual([
        { migration_id: 55, name: "metrics" },
        { migration_id: 56, name: "invitations" },
        { migration_id: 57, name: "discord_cards" },
        { migration_id: 58, name: "served_public_catalog" },
      ]);
    }),
  );
});
