import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { Schema } from "effect";
import { expect, test } from "vitest";

const budget = Schema.Struct({
  idle: Schema.Struct({ reads: Schema.Number, writes: Schema.Number }),
  quota: Schema.Struct({ reads: Schema.Number, writes: Schema.Number }),
  duplicate: Schema.Boolean,
  limited: Schema.Boolean,
  receipt: Schema.Array(Schema.Struct({ id: Schema.String, state: Schema.String })),
  next: Schema.Number,
  cleanups: Schema.Array(Schema.Number),
  deleted: Schema.Array(Schema.String),
  plans: Schema.Array(Schema.Struct({ detail: Schema.String })),
});

test("real Durable Object SQL bounds quota and cleanup access across growing history, concurrency and actor replacement", async () => {
  const source = await build({
    entryPoints: [new URL("../../test/photo-storage-worker.ts", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    external: ["cloudflare:workers", "node:*"],
    write: false,
  });
  const persistence = await mkdtemp(join(tmpdir(), "photo-ledger-"));
  const open = () =>
    new Miniflare({
      resourcePersistencePath: persistence,
      workers: [
        {
          config: {
            name: "photo-storage-test",
            compatibilityDate: "2026-10-11",
            compatibilityFlags: ["nodejs_compat"],
            exports: { PhotoLedger: { type: "durable-object", storage: "sqlite" } },
            manifest: {
              mainModule: "index.js",
              modules: { "index.js": { type: "esm", contents: source.outputFiles[0]!.text } },
            },
            env: {
              PHOTOS: {
                type: "durable-object",
                worker: "photo-storage-test",
                exportName: "PhotoLedger",
              },
            },
          },
        },
      ],
    });
  let runtime = open();
  const call = async (path: string) => {
    const response = await runtime.dispatchFetch(`https://photos.test${path}`);
    expect(response.status).toBe(200);
    return response.json();
  };
  try {
    expect(await call("/setup")).toEqual({ ready: true });
    expect(await call("/concurrent")).toEqual({ admitted: 3, total: 3 });
    let next = 0;
    for (const path of ["/small", "/large", "/idle"]) {
      const result = Schema.decodeUnknownSync(budget)(await call(path));
      expect(result.idle.writes).toBe(0);
      expect(result.idle.reads).toBeLessThanOrEqual(4);
      expect(result.quota.reads).toBeLessThan(80);
      expect(result.quota.writes).toBeLessThan(12);
      expect(result.duplicate).toBe(false);
      expect(result.limited).toBe(false);
      expect(result.receipt).toEqual([{ id: "photo-0", state: "taken" }]);
      next = result.next;
      for (const index of ["photo_cleanup", "photo_limit", "photo_pending"])
        expect(result.plans.some((row) => row.detail.includes(index))).toBe(true);
      expect(result.plans.some((row) => /SCAN |TEMP B-TREE/.test(row.detail))).toBe(false);
    }
    await runtime.dispose();
    runtime = open();
    const replacement = Schema.decodeUnknownSync(budget)(await call("/replacement"));
    expect(replacement.idle.writes).toBe(0);
    expect(replacement.idle.reads).toBeLessThanOrEqual(4);
    expect(replacement.receipt).toEqual([{ id: "photo-0", state: "taken" }]);
    expect(replacement.duplicate).toBe(false);
    expect(replacement.next).toBe(next);
    const batch = Schema.decodeUnknownSync(budget)(await call("/batch"));
    expect(batch.cleanups.every((count) => count <= 50)).toBe(true);
    expect(batch.deleted.length).toBeGreaterThanOrEqual(50);
    expect(batch.idle.reads).toBeLessThan(500);
    expect(batch.idle.writes).toBeLessThan(500);
    const drained = Schema.decodeUnknownSync(budget)(await call("/drain"));
    expect(new Set([...batch.deleted, ...drained.deleted]).size).toBe(75);
    const race = Schema.decodeUnknownSync(
      Schema.Struct({
        raced: Schema.Boolean,
        deleted: Schema.Array(Schema.String),
        remaining: Schema.Array(
          Schema.Struct({ photo_id: Schema.String, due: Schema.NullOr(Schema.Number) }),
        ),
      }),
    )(await call("/race"));
    expect(race.raced).toBe(true);
    expect(race.remaining).toEqual([]);
    expect(race.deleted).toContain("conversation-photos/photo-0.jpg");
  } finally {
    await runtime.dispose();
    await rm(persistence, { recursive: true, force: true });
  }
});
