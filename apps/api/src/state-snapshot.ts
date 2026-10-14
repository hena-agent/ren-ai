import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

const Scalar = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Null,
  Schema.Struct({ bytes: Schema.String }),
]);
export const StateSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  tables: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      columns: Schema.Array(Schema.String),
      rows: Schema.Array(Schema.Array(Scalar)),
    }),
  ),
});
export type StateSnapshot = typeof StateSnapshot.Type;
type Cell = string | number | null | Uint8Array;
const identifier = (name: string) => {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error("Invalid state identifier");
  return `"${name}"`;
};
const encode = (value: Cell) =>
  value instanceof Uint8Array ? { bytes: Buffer.from(value).toString("base64") } : value;
const decode = (value: typeof Scalar.Type): Cell =>
  typeof value === "object" && value !== null ? Buffer.from(value.bytes, "base64") : value;
const optionalTables = new Set(["failed_turn", "application_alert"]);

const schemaTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'
    AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__cf_%'
    AND name NOT IN ('effect_sql_migrations', 'application_import') ORDER BY name`;
  return yield* Effect.forEach(tables, (table) =>
    Effect.gen(function* () {
      const columns = yield* sql.unsafe<{ name: string }>(
        `PRAGMA table_info(${identifier(table.name)})`,
      );
      return { name: table.name, columns: columns.map((column) => column.name) };
    }),
  );
});

export const exportApplicationState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* Effect.gen(function* () {
    const tables = yield* schemaTables;
    const snapshot = {
      version: 1 as const,
      tables: yield* Effect.forEach(tables, (table) =>
        Effect.gen(function* () {
          const rows = yield* sql.unsafe<Record<string, Cell>>(
            `SELECT * FROM ${identifier(table.name)} ORDER BY rowid`,
          );
          return {
            ...table,
            rows: rows.map((row) => table.columns.map((column) => encode(row[column]!))),
          };
        }),
      ),
    };
    return Schema.decodeUnknownSync(StateSnapshot)(snapshot);
  }).pipe(sql.withTransaction);
});

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: validate a private state archive before any restore query
export function readStateSnapshot(input: unknown): StateSnapshot {
  try {
    return Schema.decodeUnknownSync(StateSnapshot)(input);
  } catch (cause) {
    throw new Error("Invalid application state snapshot", { cause });
  }
}

export const importApplicationState = (snapshot: StateSnapshot) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE IF NOT EXISTS application_import (id INTEGER PRIMARY KEY CHECK(id=1), digest TEXT NOT NULL)`;
    const digest = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    return yield* Effect.gen(function* () {
      const [previous] = yield* sql<{
        digest: string;
      }>`SELECT digest FROM application_import WHERE id=1`;
      if (previous) {
        if (previous.digest !== digest)
          return yield* Effect.fail(
            new Error("A different application state was already imported"),
          );
        return { digest, repeated: true };
      }
      const target = yield* schemaTables;
      const names = new Set(snapshot.tables.map((table) => table.name));
      if (
        names.size !== snapshot.tables.length ||
        target.some((table) => !optionalTables.has(table.name) && !names.has(table.name))
      )
        return yield* Effect.fail(new Error("Application state tables do not match"));
      for (const table of target) {
        const [count] = yield* sql.unsafe<{ count: number }>(
          `SELECT COUNT(*) AS count FROM ${identifier(table.name)}`,
        );
        if (count!.count !== 0)
          return yield* Effect.fail(
            new Error("Application state import requires an empty database"),
          );
      }
      yield* sql`PRAGMA defer_foreign_keys = ON`;
      for (const table of snapshot.tables) {
        const expected = target.find((value) => value.name === table.name);
        if (!expected || JSON.stringify(expected.columns) !== JSON.stringify(table.columns))
          return yield* Effect.fail(new Error("Application state columns do not match"));
        const placeholders = table.columns.map(() => "?").join(",");
        for (const row of table.rows) {
          if (row.length !== table.columns.length)
            return yield* Effect.fail(new Error("Application state row is incomplete"));
          yield* sql.unsafe(
            `INSERT INTO ${identifier(table.name)} (${table.columns.map(identifier).join(",")}) VALUES (${placeholders})`,
            row.map(decode),
          );
        }
      }
      yield* sql`INSERT INTO application_import (id,digest) VALUES (1,${digest})`;
      return { digest, repeated: false };
    }).pipe(sql.withTransaction);
  });
