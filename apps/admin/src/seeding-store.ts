import { createHash, randomUUID } from "node:crypto";
import type { D1Database } from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/d1";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { PersonaError } from "@ren-ai/personas";
import { personas, seedingRuns, seedingSeeds } from "./database-schema.ts";
import type { PersonaSeed, SeedManifest } from "./seed-selection.ts";
import { seedNameKey, decodeSeed, seedError } from "./seed-selection.ts";
import { requestId, validationFailure } from "./logging.ts";

export type SeedingRun = typeof seedingRuns.$inferSelect;
export type SeedingSeed = Omit<typeof seedingSeeds.$inferSelect, "source"> & {
  source: PersonaSeed;
};
export type SeedingStore = ReturnType<typeof seedingStore>;
const pendingStages = ["draft", "drafting", "sheets", "anime", "photo", "save"] as const;
const seed = (row: typeof seedingSeeds.$inferSelect): SeedingSeed => ({
  ...row,
  source: decodeSeed(JSON.parse(row.source)),
});

export function seedingStore(database: D1Database) {
  const db = drizzle(database);
  const get = async (id: string) => {
    const run = await db.select().from(seedingRuns).where(eq(seedingRuns.id, id)).get();
    if (!run) throw new PersonaError("not_found", "Seeding run not found");
    const rows = await db
      .select()
      .from(seedingSeeds)
      .where(eq(seedingSeeds.runId, id))
      .orderBy(asc(seedingSeeds.ordinal))
      .limit(200);
    return { run, seeds: rows.map(seed) };
  };
  const exclusions = async (cursor = "catalog:") => {
    const [kind, after] = cursor.split(":");
    if ((kind !== "catalog" && kind !== "seeds") || after === undefined) throw seedError();
    const rows =
      kind === "catalog"
        ? await db
            .select({ id: personas.id, name: personas.name, uuid: sql<string>`''` })
            .from(personas)
            .where(gt(personas.id, after))
            .orderBy(asc(personas.id))
            .limit(500)
        : await db
            .select({
              id: seedingSeeds.personaId,
              name: seedingSeeds.nameKey,
              uuid: seedingSeeds.uuid,
            })
            .from(seedingSeeds)
            .where(gt(seedingSeeds.personaId, after))
            .orderBy(asc(seedingSeeds.personaId))
            .limit(500);
    return {
      names: rows.map((row) => row.name),
      records: rows.flatMap((row) => (row.uuid ? [row.uuid] : [])),
      next:
        rows.length === 500
          ? `${kind}:${rows.at(-1)!.id}`
          : kind === "catalog"
            ? "seeds:"
            : undefined,
    };
  };
  return {
    get,
    source: async (id: string) => {
      const row = await db
        .select({ source: seedingSeeds.source })
        .from(seedingSeeds)
        .where(eq(seedingSeeds.personaId, id))
        .get();
      return decodeSeed(JSON.parse(row!.source));
    },
    active: async (id: string) =>
      Boolean(
        await db
          .select({ id: seedingSeeds.personaId })
          .from(seedingSeeds)
          .where(and(eq(seedingSeeds.personaId, id), eq(seedingSeeds.pending, true)))
          .get(),
      ),
    list: () =>
      db
        .select()
        .from(seedingRuns)
        .orderBy(sql`${seedingRuns.createdAt} DESC`)
        .limit(20),
    exclusions,
    upload: async (manifest: SeedManifest) => {
      const digest = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
      const previous = await db
        .select()
        .from(seedingRuns)
        .where(eq(seedingRuns.digest, digest))
        .get();
      if (previous) return previous.id;
      let cursor = "catalog:";
      while (cursor.startsWith("catalog:")) {
        const page = await exclusions(cursor);
        const names = new Set(page.names.map(seedNameKey));
        if (manifest.seeds.some((item) => names.has(seedNameKey(item.name))))
          throw new PersonaError("conflict", "A seed name is already in the Catalog");
        cursor = page.next!;
      }
      const id = randomUUID();
      try {
        await db.batch([
          db.insert(seedingRuns).values({
            id,
            digest,
            dataset: manifest.dataset,
            revision: manifest.revision,
            selectedOn: manifest.date,
            createdAt: Date.now(),
            requestId: requestId(),
          }),
          ...manifest.seeds.map((item, ordinal) =>
            db.insert(seedingSeeds).values({
              personaId: randomUUID(),
              runId: id,
              dataset: manifest.dataset,
              uuid: item.uuid,
              nameKey: seedNameKey(item.name),
              source: JSON.stringify(item),
              ordinal,
              stage: "draft",
            }),
          ),
        ]);
      } catch (cause) {
        // D1's UNIQUE constraints make concurrent submissions and consumed records atomic.
        if (
          !(
            cause instanceof Error &&
            cause.cause instanceof Error &&
            cause.cause.message.includes("UNIQUE constraint failed: seeding_")
          )
        )
          throw validationFailure(
            "Seeding persistence failed",
            { stage: "seeding.upload", code: "database_error" },
            cause,
          );
        const repeated = await db
          .select()
          .from(seedingRuns)
          .where(eq(seedingRuns.digest, digest))
          .get();
        if (repeated) return repeated.id;
        const error = new PersonaError(
          "conflict",
          "Seeding upload conflicts; reload exclusions and select again",
        );
        error.cause = cause;
        throw error;
      }
      return id;
    },
    confirm: async (id: string, budgetMicros: number) => {
      await db.batch([
        db
          .update(seedingSeeds)
          .set({ pending: true })
          .where(
            and(
              eq(seedingSeeds.runId, id),
              sql`EXISTS (SELECT 1 FROM ${seedingRuns} WHERE ${seedingRuns.id} = ${id} AND ${seedingRuns.confirmed} = 0)`,
            ),
          ),
        db
          .update(seedingRuns)
          .set({ confirmed: true, budgetMicros, requestId: requestId() })
          .where(and(eq(seedingRuns.id, id), eq(seedingRuns.confirmed, false))),
      ]);
    },
    next: async () => {
      const row = await db
        .select({ seed: seedingSeeds, run: seedingRuns })
        .from(seedingSeeds)
        .innerJoin(seedingRuns, eq(seedingSeeds.runId, seedingRuns.id))
        .where(eq(seedingSeeds.pending, true))
        .orderBy(asc(seedingSeeds.runId), asc(seedingSeeds.ordinal))
        .limit(1)
        .get();
      return row ? { seed: seed(row.seed), run: row.run } : undefined;
    },
    stage: async (id: string, stage: SeedingSeed["stage"]) => {
      await db
        .update(seedingSeeds)
        .set({ stage, pending: pendingStages.some((value) => value === stage), retryStage: null })
        .where(eq(seedingSeeds.personaId, id));
    },
    fail: async (id: string) => {
      await db
        .update(seedingSeeds)
        .set({ stage: "failed", pending: false, retryStage: sql`${seedingSeeds.stage}` })
        .where(eq(seedingSeeds.personaId, id));
    },
    reserve: async (runId: string, micros: number) => {
      const result = await db
        .update(seedingRuns)
        .set({ reservedMicros: sql`${seedingRuns.reservedMicros} + ${micros}` })
        .where(
          and(
            eq(seedingRuns.id, runId),
            eq(seedingRuns.confirmed, true),
            sql`${seedingRuns.reservedMicros} + ${micros} <= ${seedingRuns.budgetMicros}`,
          ),
        )
        .run();
      if (!result.meta.changes) throw new PersonaError("conflict", "Seeding run budget exhausted");
    },
  };
}
