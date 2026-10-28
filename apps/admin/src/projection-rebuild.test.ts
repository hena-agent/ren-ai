import type { D1Database } from "@cloudflare/workers-types";
import { fromPartial } from "@total-typescript/shoehorn";
import { expect, test } from "vitest";
import { cloudflareFixture, databasePersona } from "../test/cloudflare-fixture.ts";
import { initialDocuments } from "../test/fixtures.ts";
import { rebuildProjections } from "./projection-rebuild.ts";

const projections = async (db: D1Database) =>
  (
    await db
      .prepare("SELECT id, projection FROM personas ORDER BY id")
      .all<{ id: string; projection: string }>()
  ).results;

test("rebuilding rewrites only missing or changed projections, in batches", async () => {
  const { db, store } = await cloudflareFixture();
  await store.save(databasePersona, initialDocuments, { persona: "" });
  const [saved] = await projections(db);
  expect(await rebuildProjections(db)).toEqual({ personas: 1, updated: 0 });
  const columns =
    "name, gender, descriptionVersion, currentVersion, timeZone, language, openingLine, memoryInstruction, published, state, memory, revision, commitId, createdAt, updatedAt";
  await db
    .prepare(
      `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < 60)
      INSERT INTO personas (id, ${columns}, projection)
      SELECT 'copy-' || i, ${columns}, '' FROM personas, n WHERE id = ?`,
    )
    .bind(databasePersona.id)
    .run();
  await db
    .prepare(
      `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < 60)
      INSERT INTO persona_versions (personaId, version, markdown, createdAt, restoredFrom)
      SELECT 'copy-' || i, version, markdown, createdAt, restoredFrom FROM persona_versions, n
      WHERE personaId = ?`,
    )
    .bind(databasePersona.id)
    .run();
  expect(await rebuildProjections(db)).toEqual({ personas: 61, updated: 60 });
  expect(new Set((await projections(db)).map((row) => row.projection))).toEqual(
    new Set([saved!.projection]),
  );
  expect(await store.list()).toHaveLength(61);
});

test("a Persona the previous version published fails the public list until her projection is rebuilt", async () => {
  const { db, store } = await cloudflareFixture();
  await store.save(databasePersona, initialDocuments, { persona: "" });
  // The previous version publishes without writing a projection.
  await db.prepare("UPDATE personas SET published = 1").run();
  await expect(store.publicList()).rejects.toMatchObject({
    cause: { message: `Published persona ${databasePersona.id} has no public projection` },
  });
  expect(await rebuildProjections(db)).toEqual({ personas: 1, updated: 1 });
  expect(await store.publicList()).toMatchObject([{ id: databasePersona.id }]);
});

test("a Persona saved during the rebuild keeps the projection her save derived", async () => {
  const { db, store } = await cloudflareFixture();
  await store.save(databasePersona, initialDocuments, { persona: "" });
  await db.prepare("UPDATE personas SET projection = ''").run();
  const concurrent = fromPartial<D1Database>({
    prepare: (query: string) => db.prepare(query),
    batch: async (statements: Parameters<D1Database["batch"]>[0]) => {
      await db
        .prepare("UPDATE personas SET revision = revision + 1, projection = 'saved meanwhile'")
        .run();
      return db.batch(statements);
    },
  });
  expect(await rebuildProjections(concurrent)).toEqual({ personas: 1, updated: 1 });
  expect(await projections(db)).toEqual([
    { id: databasePersona.id, projection: "saved meanwhile" },
  ]);
});
