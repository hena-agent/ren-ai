import { Clock, Effect, Result, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { PublicPersona } from "@ren-ai/onboarding";
import { contactCause, contactLog, type ContactLog } from "../discovery/diagnostics.ts";

const Profiles = Schema.fromJsonString(Schema.Array(PublicPersona));
const decode = (payload: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(Profiles)(payload),
    catch: (cause) => new Error("Invalid public Catalog snapshot", { cause }),
  });

/** Only browsing can use stale public data. Registration and Selection load the source afresh. */
export const publicCatalog = (
  load: () => Promise<readonly PublicPersona[]>,
  log: ContactLog = contactLog,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const lock = yield* Semaphore.make(1);
    const read = (requestId: string) =>
      lock.withPermit(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const [snapshot] = yield* sql<{
            payload: string | null;
            loaded_at: number;
            retry_at: number;
            generation: number;
          }>`SELECT payload, loaded_at, retry_at, generation FROM public_catalog WHERE id = 1`;
          if (snapshot!.payload && (now < snapshot!.loaded_at + 60_000 || now < snapshot!.retry_at))
            return yield* decode(snapshot!.payload);
          const result = yield* Effect.tryPromise({
            try: load,
            catch: (cause) => new Error("Public Catalog unavailable", { cause }),
          }).pipe(
            Effect.flatMap((profiles) =>
              Effect.try({
                try: () => Schema.encodeSync(Profiles)(profiles),
                catch: (cause) => new Error("Invalid public Catalog response", { cause }),
              }),
            ),
            Effect.result,
          );
          if (Result.isSuccess(result)) {
            const loaded = yield* Clock.currentTimeMillis;
            const saved =
              yield* sql`UPDATE public_catalog SET payload = ${result.success}, loaded_at = ${loaded}, retry_at = 0
        WHERE id = 1 AND generation = ${snapshot!.generation} RETURNING id`;
            if (!saved.length)
              return yield* Effect.fail(new Error("Public Catalog changed during refresh"));
            return yield* decode(result.success);
          }
          const checked = yield* Clock.currentTimeMillis;
          if (!snapshot!.payload || checked >= snapshot!.loaded_at + 360_000)
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
          return yield* decode(snapshot!.payload);
        }),
      );
    return { read };
  });

/** Fence in-flight reads as well as persisted stale data when Admin commits a change. */
export const invalidatePublicCatalog = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE public_catalog SET payload = NULL, loaded_at = 0, retry_at = 0, generation = generation + 1 WHERE id = 1`;
});
