import { Clock, Effect, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/sql";
import { PublicPersona } from "@ren-ai/onboarding";
import { scheduleWork } from "../scheduling.ts";
import { maintenanceWork } from "../work-budget.ts";
import { reclaimBrowseSnapshots, saveBrowseSnapshot } from "./browse-snapshot.ts";

const Profiles = Schema.Array(PublicPersona);
const maintenance = "catalog.public";

/**
 * Browsing serves the stored snapshot without waiting for Admin; only a missing or invalidated
 * one is loaded on demand. Registration and Selection still load the source afresh.
 */
export const publicCatalog = (load: () => Promise<readonly PublicPersona[]>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const lock = yield* Semaphore.make(1);
    const stored = Effect.map(
      sql<{
        payload: string | null;
        revision: string | null;
        generation: number;
      }>`SELECT payload, revision, generation FROM public_catalog WHERE id = 1`,
      ([row]) => row!,
    );
    const served = Effect.map(
      sql<{ revision: string }>`SELECT revision FROM public_catalog WHERE id = 1 AND payload IS NOT NULL`,
      ([row]) => row?.revision,
    );
    // An invalidation during the load fences its result; an unchanged source writes nothing.
    const replace = Effect.gen(function* () {
      const before = yield* stored;
      const profiles = yield* Effect.tryPromise({
        try: load,
        catch: (cause) => new Error("Public Catalog unavailable", { cause }),
      }).pipe(
        Effect.flatMap((source) =>
          Effect.try({
            try: () => Schema.decodeUnknownSync(Profiles)(source),
            catch: (cause) => new Error("Invalid public Catalog response", { cause }),
          }),
        ),
      );
      const payload = JSON.stringify(profiles);
      const fenced = Effect.flatMap(stored, (latest) =>
        latest.generation === before.generation
          ? Effect.succeed(latest)
          : Effect.fail(new Error("Public Catalog changed during refresh")),
      );
      const latest = yield* fenced;
      if (latest.payload === payload) return latest.revision!;
      const now = yield* Clock.currentTimeMillis;
      return yield* Effect.gen(function* () {
        const { revision: previous } = yield* fenced;
        const revision = yield* saveBrowseSnapshot(profiles, now, previous);
        yield* sql`UPDATE public_catalog SET payload = ${payload}, revision = ${revision}, loaded_at = ${now} WHERE id = 1`;
        return revision;
      }).pipe(sql.withTransaction);
    });
    return {
      /** The served snapshot's revision; concurrent first loads coalesce. */
      ensure: Effect.gen(function* () {
        const revision = yield* served;
        if (revision) return revision;
        return yield* lock.withPermit(
          Effect.flatMap(served, (latest) => (latest ? Effect.succeed(latest) : replace)),
        );
      }),
      /** Bounded maintenance: reclaim expired snapshots, then replace the served one from Admin. */
      maintain: maintenanceWork(
        maintenance,
        lock.withPermit(Effect.andThen(reclaimBrowseSnapshots, replace)).pipe(Effect.asVoid),
      ),
    };
  });

/** Fence in-flight loads and the served snapshot; the next read or maintenance reloads it. */
export const invalidatePublicCatalog = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE public_catalog SET payload = NULL, generation = generation + 1 WHERE id = 1`;
});

/** Admin committed a change: fence the served snapshot and reload it on the next alarm. */
export const reloadPublicCatalog = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* invalidatePublicCatalog;
  yield* sql`DELETE FROM application_clock WHERE name = ${maintenance}`;
  yield* scheduleWork("maintenance", yield* Clock.currentTimeMillis);
});
