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
      yield* sql`INSERT INTO conversation_photo VALUES
        ('taken',9,'ses_preserved','photo_taken','taken',10,11,100,1),
        ('pending',9,'ses_preserved','photo_pending','pending',12,NULL,NULL,0),
        ('declined',9,'ses_preserved','photo_declined','declined',13,NULL,NULL,1)`;
      yield* sql`INSERT INTO photo_object VALUES ('taken',NULL),('pending',1234),('orphan',0)`;
      yield* sql`UPDATE photo_setting SET enabled = 0 WHERE id = 1`;
      yield* sql`INSERT INTO application_work (name,due) VALUES ('photo-cleanup',1234)`;
      yield* sql`INSERT INTO bookmark VALUES (1,123,456)`;
      yield* sql`INSERT INTO intake_seen VALUES ('ses_preserved','guid_preserved')`;
      yield* sql`INSERT INTO intake_pending(guid, handle, payload) VALUES ('pending', 'private-marker@example.test',
        ${JSON.stringify({ id: 124, guid: "pending", handle: "private-marker@example.test", createdAt: 6, text: "queued", fromMe: false })})`;
      yield* sql`INSERT INTO application_checkpoint VALUES ('replay:ses_preserved', ${JSON.stringify({ cursor: 40, previous: 2, firstReply: 1, latestReply: 2, latestSend: 0 })})`;
      yield* sql`INSERT INTO catalog_plan VALUES ('ses_preserved', 'fingerprint', 'sora')`;
      yield* sql`INSERT INTO invitation_settings VALUES (1, 1)`;
      yield* sql`INSERT INTO invitation_grant VALUES ('private-marker@example.test', 2)`;
      yield* sql`INSERT INTO invitation VALUES (${"a".repeat(64)}, 'private-marker@example.test', 'friend@example.test', 3)`;
      yield* sql`CREATE TABLE probe_blob (id INTEGER PRIMARY KEY, value BLOB, nullable TEXT)`;
      yield* sql`INSERT INTO probe_blob VALUES (1,${new Uint8Array([1, 2, 255])},NULL)`;
      return yield* exportApplicationState;
    }),
  );
  expect(snapshot.tables.map((table) => table.name)).not.toContain("effect_sql_migrations");
  expect(snapshot.tables.map((table) => table.name)).not.toContain("public_catalog");
  expect(snapshot.tables.map((table) => table.name)).not.toContain("intake_handle");
  const decoded = readStateSnapshot(JSON.parse(JSON.stringify(snapshot)));
  await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE probe_blob (id INTEGER PRIMARY KEY, value BLOB, nullable TEXT)`;
      expect((yield* importApplicationState(decoded)).repeated).toBe(false);
      expect((yield* importApplicationState(decoded)).repeated).toBe(true);
      expect(yield* exportApplicationState).toEqual(decoded);
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
      expect(yield* sql`SELECT handle, head, retry_at FROM intake_handle`).toEqual([
        { handle: "private-marker@example.test", head: 1, retry_at: 0 },
      ]);
      expect(yield* sql`SELECT name FROM application_checkpoint`).toEqual([
        { name: "replay:ses_preserved" },
      ]);
      expect(yield* sql`SELECT session_id FROM catalog_plan`).toEqual([
        { session_id: "ses_preserved" },
      ]);
      expect(yield* sql`SELECT * FROM invitation_settings`).toEqual([{ id: 1, enabled: 1 }]);
      expect(yield* sql`SELECT redeemed_by, redeemed_at FROM invitation`).toEqual([
        { redeemed_by: "friend@example.test", redeemed_at: 3 },
      ]);
      const [blob] = yield* sql<{
        value: Uint8Array;
        nullable: string | null;
      }>`SELECT value,nullable FROM probe_blob`;
      expect([...blob!.value]).toEqual([1, 2, 255]);
      expect(blob!.nullable).toBeNull();
      yield* sql`DELETE FROM conversation WHERE id = 9`;
      expect(yield* sql`SELECT * FROM conversation_photo`).toEqual([]);
      expect(yield* sql`SELECT * FROM photo_object ORDER BY photo_id`).toEqual([
        { photo_id: "orphan", due: 0 },
        { photo_id: "pending", due: 1234 },
        { photo_id: "taken", due: 0 },
      ]);
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

test("state transfers exclude Cloudflare-owned tables without inspecting or restoring them", async () => {
  const internalTables = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const name of ["_cf_METADATA", "__cf_KV"]) {
      yield* sql.unsafe(`CREATE TABLE "${name}" (id INTEGER)`);
      yield* sql.unsafe(`INSERT INTO "${name}" VALUES (1)`);
    }
  });
  const snapshot = await run(internalTables.pipe(Effect.andThen(exportApplicationState)));
  expect(snapshot.tables.map((table) => table.name)).not.toContain("_cf_METADATA");
  expect(snapshot.tables.map((table) => table.name)).not.toContain("__cf_KV");
  await run(
    internalTables.pipe(
      Effect.andThen(importApplicationState(snapshot)),
      Effect.map((result) => expect(result.repeated).toBe(false)),
    ),
  );
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
      expect(yield* sql`SELECT * FROM photo_setting`).toEqual([{ id: 1, enabled: 1 }]);
      expect((yield* importApplicationState(empty)).repeated).toBe(false);
    }),
  );
});

test.each([
  "UPDATE photo_setting SET enabled = 0 WHERE id = 1",
  "INSERT INTO photo_object VALUES ('pending-cleanup',0)",
])("restore refuses existing photo state: %s", async (statement) => {
  const empty = await run(exportApplicationState);
  await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(statement);
      const before = yield* exportApplicationState;
      const error = yield* importApplicationState(empty).pipe(Effect.flip);
      expect(String(error)).toContain("empty database");
      expect(yield* exportApplicationState).toEqual(before);
    }),
  );
});
