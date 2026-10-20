import { expect, test } from "vitest";
import { Schema } from "effect";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { seedingSeeds, seedingRuns } from "./database-schema.ts";
import type { D1Database } from "@cloudflare/workers-types";
import { cloudflareAdmin } from "./cloudflare-admin.ts";
import { adminBindings, cloudflareFixture } from "../test/cloudflare-fixture.ts";
import { memoryStorage } from "../test/memory-storage.ts";
import { captureWorkerLogs } from "../test/worker-logs.ts";
import { seedManifest, uploadSeeds } from "../test/seeding.ts";
import { request } from "../test/fixtures.ts";
import { deferred } from "../test/queue.ts";

const Exclusions = Schema.Struct({
  names: Schema.Array(Schema.String),
  records: Schema.Array(Schema.String),
  next: Schema.optionalKey(Schema.String),
});

const personaColumns =
  "id, name, timeZone, language, openingLine, memoryInstruction, published, state, memory, revision, commitId, createdAt, updatedAt";

type Database = Awaited<ReturnType<typeof cloudflareFixture>>["db"];

const ledgerCounts = (db: Database) =>
  db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM seeding_runs) AS runs, (SELECT COUNT(*) FROM seeding_seeds) AS seeds",
    )
    .first<{ runs: number; seeds: number }>();

async function insertCatalog(db: Database, count: number, finalName?: string) {
  await db
    .prepare(
      `INSERT INTO personas (${personaColumns})
       WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
       SELECT printf('c%04d', n), printf('catalog%04d', n), 'Asia/Seoul', 'ko', '', '',
         0, '{}', '', 1, 'fixture', 0, 0 FROM seq`,
    )
    .bind(count - 1)
    .run();
  if (!finalName) return;
  await db
    .prepare(
      `INSERT INTO personas (${personaColumns})
       VALUES (?, ?, 'Asia/Seoul', 'ko', '', '', 0, '{}', '', 1, 'fixture', 0, 0)`,
    )
    .bind(`c${String(count).padStart(4, "0")}`, finalName)
    .run();
}

async function insertReceipts(db: Database, runId: string, count: number) {
  await db
    .prepare(
      `INSERT INTO seeding_seeds
         (personaId, runId, dataset, uuid, nameKey, source, ordinal, stage, pending)
       WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
       SELECT printf('z%04d', n), ?, 'nvidia/Nemotron-Personas-Korea',
         printf('receipt-%04d', n), printf('receipt-%04d', n), '{}', n, 'done', 0 FROM seq`,
    )
    .bind(count - 1, runId)
    .run();
}

async function exclusionPages(admin: Awaited<ReturnType<typeof cloudflareAdmin>>, start?: string) {
  const pages: (typeof Exclusions.Type)[] = [];
  let cursor = start;
  do {
    const path = cursor
      ? `/seeding/exclusions?cursor=${encodeURIComponent(cursor)}`
      : "/seeding/exclusions";
    const response = await admin.fetch(request(path));
    expect(response.status).toBe(200);
    const page = Schema.decodeUnknownSync(Exclusions)(await response.json());
    pages.push(page);
    cursor = page.next;
  } while (cursor);
  return pages;
}

function concurrentUploads(database: D1Database, seedCount: number) {
  const first = deferred<void>();
  const second = deferred<void>();
  let batches = 0;
  const gated: D1Database = {
    prepare: (query) => database.prepare(query),
    exec: (query) => database.exec(query),
    dump: () => database.dump(),
    withSession: (constraint) => database.withSession(constraint),
    batch: async (statements) => {
      if (statements.length !== seedCount + 1) return database.batch(statements);
      batches++;
      if (batches === 1) {
        first.resolve();
        await second.promise;
      } else if (batches === 2) second.resolve();
      return database.batch(statements);
    },
  };
  return { database: gated, first: first.promise, attempts: () => batches };
}

test("exclusions page through more than five hundred Catalog names and consumed receipts", async () => {
  const { db, bucket } = await cloudflareFixture();
  const admin = await cloudflareAdmin(adminBindings(db, bucket), memoryStorage().storage);
  const manifest = seedManifest();
  await insertCatalog(db, 1000, manifest.seeds[0]!.name);
  const catalog = await exclusionPages(admin);
  expect(catalog.map((page) => page.names.length)).toEqual([500, 500, 1, 0]);
  expect(catalog[0]!.next).toBe("catalog:c0499");
  expect(catalog[1]!.next).toBe("catalog:c0999");
  expect(catalog[2]).toMatchObject({ names: [manifest.seeds[0]!.name], next: "seeds:" });
  // The Catalog guard scans past the first page, so a late duplicate never persists a run.
  expect((await admin.fetch(uploadSeeds())).status).toBe(409);

  await db.prepare("DELETE FROM personas WHERE id = 'c1000'").run();
  const location = (await admin.fetch(uploadSeeds())).headers.get("location")!;
  await insertReceipts(db, location.slice("/seeding/".length), 1001);
  const receipts = await exclusionPages(admin, "seeds:");
  expect(receipts.map((page) => page.records.length)).toEqual([500, 500, 5]);
  expect(new Set(receipts.flatMap((page) => page.records)).size).toBe(1005);
  expect(receipts.flatMap((page) => page.records)).toEqual(
    expect.arrayContaining(manifest.seeds.map((seed) => seed.uuid)),
  );
  expect(receipts.at(-1)!.next).toBeUndefined();
});

test("concurrent identical uploads resolve to one run through the unique-digest recovery", async () => {
  const { db, bucket } = await cloudflareFixture();
  const manifest = seedManifest();
  const concurrent = concurrentUploads(db, manifest.seeds.length);
  const admin = await cloudflareAdmin(
    { ...adminBindings(db, bucket), DB: concurrent.database },
    memoryStorage().storage,
  );
  const uploading = admin.fetch(uploadSeeds());
  await concurrent.first;
  const responses = await Promise.all([uploading, admin.fetch(uploadSeeds())]);
  expect(responses.map((response) => response.status)).toEqual([303, 303]);
  expect(concurrent.attempts()).toBe(2);
  const locations = responses.map((response) => response.headers.get("location"));
  expect(new Set(locations).size).toBe(1);
  expect(await ledgerCounts(db)).toEqual({ runs: 1, seeds: manifest.seeds.length });
  const shape = getTableConfig(seedingSeeds);
  expect(shape.foreignKeys.map((key) => key.reference().foreignTable)).toEqual([seedingRuns]);
  const actualIndexes = (
    await db.prepare("PRAGMA index_list('seeding_seeds')").all<{ name: string }>()
  ).results;
  for (const index of shape.indexes)
    expect(actualIndexes.map((entry) => entry.name)).toContain(index.config.name);
  await expect(db.prepare("DELETE FROM seeding_runs").run()).rejects.toThrow("FOREIGN KEY");
});

test("non-unique persistence failures return 503 with correlated private diagnostics", async () => {
  const { db, bucket } = await cloudflareFixture();
  const logs = captureWorkerLogs();
  try {
    const admin = await cloudflareAdmin(adminBindings(db, bucket), memoryStorage().storage);
    await db
      .prepare(
        "CREATE TRIGGER fail_seeding INSERT ON seeding_seeds BEGIN SELECT RAISE(FAIL, 'private-source storage outage'); END",
      )
      .run();
    const manifest = seedManifest();
    const response = await admin.fetch(
      new Request(uploadSeeds(), {
        method: "POST",
        body: JSON.stringify({
          ...manifest,
          seeds: manifest.seeds.map((seed) => ({
            ...seed,
            source: { ...seed.source, unit: "1", language: "ko" },
          })),
        }),
      }),
    );
    expect(response.status).toBe(503);
    const id = response.headers.get("x-request-id")!;
    const body = await response.text();
    expect(body).toContain("요청 ID:");
    expect(body).toContain(id);
    const diagnostics = logs.stderr.mock.calls.join(" ");
    expect(diagnostics).toContain(`"requestId":"${id}"`);
    expect(diagnostics).toContain('"stage":"seeding.upload"');
    expect(diagnostics).toContain('"code":"database_error"');
    expect(diagnostics).toContain('"status":503');
    expect(diagnostics).not.toContain("private-source");
    expect(diagnostics).not.toContain(seedManifest().seeds[0]!.name);
    expect(diagnostics).not.toContain('"persona":"');
    expect(await ledgerCounts(db)).toEqual({ runs: 0, seeds: 0 });
  } finally {
    logs.stdout.mockRestore();
    logs.stderr.mockRestore();
  }
});
