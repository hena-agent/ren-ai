import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { migrate } from "./database.ts";
import {
  exportApplicationState,
  exportReadOnlyApplicationState,
  importApplicationState,
  readStateSnapshot,
} from "./state-snapshot.ts";

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* migrate;
        return yield* effect;
      }),
    ).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  );

test("application state transfers identities, links, cursors, uncertainty and blobs without replay", async () => {
  const snapshot = await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO user (id,handle,locale,consent_version,consent_language,consent_at,joined_at) VALUES (7,'private-marker@example.test','ko','v1','ko',1,2)`;
      yield* sql`INSERT INTO conversation (id,user_id,persona_id,session_id,started_at) VALUES (9,7,'sora','ses_preserved',3)`;
      yield* sql`INSERT INTO send (id,handle,conversation_id,kind,content,tool_call_id,state,recorded_at,updated_at) VALUES (33,'private-marker@example.test',9,'text','private greeting marker','call_preserved','uncertain',4,5)`;
      yield* sql`INSERT INTO bookmark VALUES (1,123,456)`;
      yield* sql`INSERT INTO intake_seen VALUES ('ses_preserved','guid_preserved')`;
      yield* sql`CREATE TABLE probe_blob (id INTEGER PRIMARY KEY, value BLOB, nullable TEXT)`;
      yield* sql`INSERT INTO probe_blob VALUES (1,${new Uint8Array([1, 2, 255])},NULL)`;
      return yield* exportApplicationState;
    }),
  );
  expect(snapshot.tables.map((table) => table.name)).not.toContain("effect_sql_migrations");
  const decoded = readStateSnapshot(JSON.parse(JSON.stringify(snapshot)));
  await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE probe_blob (id INTEGER PRIMARY KEY, value BLOB, nullable TEXT)`;
      expect((yield* importApplicationState(decoded)).repeated).toBe(false);
      expect((yield* importApplicationState(decoded)).repeated).toBe(true);
      expect(yield* sql`SELECT id,session_id FROM conversation`).toEqual([
        { id: 9, session_id: "ses_preserved" },
      ]);
      expect(yield* sql`SELECT id,state,tool_call_id FROM send`).toEqual([
        { id: 33, state: "uncertain", tool_call_id: "call_preserved" },
      ]);
      expect(yield* sql`SELECT * FROM bookmark`).toEqual([{ id: 1, row_id: 123, date: 456 }]);
      expect(yield* sql`SELECT * FROM intake_seen`).toEqual([
        { session_id: "ses_preserved", guid: "guid_preserved" },
      ]);
      const [blob] = yield* sql<{
        value: Uint8Array;
        nullable: string | null;
      }>`SELECT value,nullable FROM probe_blob`;
      expect([...blob!.value]).toEqual([1, 2, 255]);
      expect(blob!.nullable).toBeNull();
      yield* importApplicationState({ ...decoded, tables: [] }).pipe(
        Effect.flip,
        Effect.map((error) => expect(String(error)).toContain("different")),
      );
    }),
  );
});

test("deferred source snapshots commit successful reads and rollback schema failures", async () => {
  expect((await run(exportReadOnlyApplicationState)).version).toBe(1);
  await expect(
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe('CREATE TABLE "invalid-name" (id INTEGER)');
        return yield* exportReadOnlyApplicationState;
      }),
    ),
  ).rejects.toThrow("Invalid state identifier");
});

test("restore refuses nonempty targets, unknown schemas, incomplete rows and conflicting archives", async () => {
  const empty = await run(exportApplicationState);
  const cases = [
    { ...empty, tables: [] },
    { ...empty, tables: [...empty.tables, empty.tables[0]!] },
    {
      ...empty,
      tables: empty.tables.map((table, index) =>
        index === 0 ? { ...table, name: "unrecognized" } : table,
      ),
    },
    {
      ...empty,
      tables: empty.tables.map((table, index) =>
        index === 0 ? { ...table, columns: ["wrong"] } : table,
      ),
    },
    {
      ...empty,
      tables: empty.tables.map((table, index) => (index === 0 ? { ...table, rows: [[]] } : table)),
    },
  ];
  for (const snapshot of cases)
    await expect(run(importApplicationState(snapshot))).rejects.toThrow(
      /tables|columns|incomplete/,
    );
  await expect(
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO blocked VALUES ('existing',1)`;
        yield* importApplicationState(empty);
      }),
    ),
  ).rejects.toThrow("empty database");
  expect(() => readStateSnapshot({ version: 1, tables: "private archive marker" })).toThrow(
    "Invalid application state snapshot",
  );
  await expect(
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe('CREATE TABLE "invalid-name" (id INTEGER)');
        return yield* exportApplicationState;
      }),
    ),
  ).rejects.toThrow("Invalid state identifier");
});

test("a restore constraint failure rolls back every table and supports a corrected retry", async () => {
  const empty = await run(exportApplicationState);
  const invalid = {
    ...empty,
    tables: empty.tables.map((table) =>
      table.name === "blocked"
        ? {
            ...table,
            rows: [
              ["same", 1],
              ["same", 2],
            ],
          }
        : table,
    ),
  };
  await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* importApplicationState(invalid).pipe(Effect.flip);
      expect(yield* sql`SELECT * FROM blocked`).toEqual([]);
      expect((yield* importApplicationState(empty)).repeated).toBe(false);
    }),
  );
});
