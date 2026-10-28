import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Internal schema names only. Preserve child rows before replacing a UNIQUE parent. */
export const rebuildHistoryParent = (
  table: string,
  unique: string,
  column: string,
  children: readonly string[],
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [parent] = yield* sql<{
      sql: string;
    }>`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${table}`;
    const columns = yield* sql.unsafe<{ name: string }>(`PRAGMA table_info(${table})`);
    const source = parent!.sql;
    if (!source.startsWith(`CREATE TABLE ${table}`) || !source.includes(unique))
      yield* Effect.fail(new Error("Unexpected history parent schema"));
    const temporary = `history_${table}`;
    yield* sql.unsafe(
      source
        .replace(`CREATE TABLE ${table}`, `CREATE TABLE ${temporary}`)
        .replace(unique, unique.replace(" UNIQUE", ""))
        .replace(/\)\s*$/, `, ${column} INTEGER)`),
    );
    const names = columns.map((entry) => `"${entry.name}"`).join(",");
    yield* sql.unsafe(`INSERT INTO ${temporary} (${names}) SELECT ${names} FROM ${table}`);
    const definitions: { name: string; sql: string }[] = [];
    for (const name of children) {
      const [definition] = yield* sql<{
        name: string;
        sql: string;
      }>`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name = ${name}`;
      if (!definition) return yield* Effect.fail(new Error("History child table missing"));
      definitions.push(definition);
      yield* sql.unsafe(`CREATE TABLE history_${name} AS SELECT * FROM "${name}"`);
      yield* sql.unsafe(`DROP TABLE "${name}"`);
    }
    yield* sql.unsafe(`DROP TABLE ${table}`);
    yield* sql.unsafe(`ALTER TABLE ${temporary} RENAME TO ${table}`);
    for (const child of definitions) {
      yield* sql.unsafe(child.sql);
      yield* sql.unsafe(`INSERT INTO "${child.name}" SELECT * FROM history_${child.name}`);
      yield* sql.unsafe(`DROP TABLE history_${child.name}`);
    }
    if ((yield* sql`PRAGMA foreign_key_check`).length)
      yield* Effect.fail(new Error("History schema foreign key validation failed"));
    return undefined;
  });
