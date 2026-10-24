import { Effect, Exit } from "effect";
import { Migrator, SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { withContactDatabase } from "./discovery/contact.test-helper.ts";
import { migrateBatches } from "./migrations.ts";

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
