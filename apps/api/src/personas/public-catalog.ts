import { Clock, Effect, Result, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/sql";
import { PublicPersona } from "@ren-ai/onboarding";
import { contactCause, contactLog, type ContactLog } from "../discovery/diagnostics.ts";
import { saveBrowseSnapshot } from "./browse-snapshot.ts";

const Profiles = Schema.Array(PublicPersona);

/** Only browsing can use stale public data. Registration and Selection load the source afresh. */
export const publicCatalog = (
  load: () => Promise<readonly PublicPersona[]>,
  log: ContactLog = contactLog,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const lock = yield* Semaphore.make(1);
    const ensure = (requestId: string) =>
      lock.withPermit(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const [snapshot] = yield* sql<{
            present: number;
            revision: string | null;
            loaded_at: number;
            retry_at: number;
            generation: number;
          }>`SELECT payload IS NOT NULL AS present, revision, loaded_at, retry_at, generation FROM public_catalog WHERE id = 1`;
          if (snapshot!.present && (now < snapshot!.loaded_at + 60_000 || now < snapshot!.retry_at))
            return snapshot!.revision!;
          const result = yield* Effect.tryPromise({
            try: load,
            catch: (cause) => new Error("Public Catalog unavailable", { cause }),
          }).pipe(
            Effect.flatMap((profiles) =>
              Effect.try({
                try: () => Schema.decodeUnknownSync(Profiles)(profiles),
                catch: (cause) => new Error("Invalid public Catalog response", { cause }),
              }),
            ),
            Effect.result,
          );
          if (Result.isSuccess(result)) {
            const loaded = yield* Clock.currentTimeMillis;
            return yield* Effect.gen(function* () {
              const [current] = yield* sql<{
                generation: number;
              }>`SELECT generation FROM public_catalog WHERE id = 1`;
              if (current!.generation !== snapshot!.generation)
                return yield* Effect.fail(new Error("Public Catalog changed during refresh"));
              const revision = yield* saveBrowseSnapshot(result.success, loaded);
              yield* sql`UPDATE public_catalog SET payload = ${JSON.stringify(result.success)}, revision = ${revision}, loaded_at = ${loaded}, retry_at = 0 WHERE id = 1`;
              return revision;
            }).pipe(sql.withTransaction);
          }
          const checked = yield* Clock.currentTimeMillis;
          if (!snapshot!.present || checked >= snapshot!.loaded_at + 360_000)
            return yield* Effect.fail(result.failure);
          const unchanged =
            yield* sql`UPDATE public_catalog SET retry_at = ${Math.min(checked + 10_000, snapshot!.loaded_at + 360_000)}
      WHERE id = 1 AND generation = ${snapshot!.generation} RETURNING id`;
          if (!unchanged.length) return yield* Effect.fail(result.failure);
          log({
            requestId,
            operation: "discovery.catalog",
            stage: "catalog.stale",
            outcome: "failed",
            level: "warn",
            durationMs: checked - now,
            ...contactCause(result.failure),
          });
          return snapshot!.revision!;
        }),
      );
    return { ensure };
  });

/** Fence in-flight reads as well as persisted stale data when Admin commits a change. */
export const invalidatePublicCatalog = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE public_catalog SET payload = NULL, loaded_at = 0, retry_at = 0, generation = generation + 1 WHERE id = 1`;
});
