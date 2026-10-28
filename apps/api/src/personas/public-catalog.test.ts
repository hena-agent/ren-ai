import { Clock, Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/sql";
import { expect, test, vi } from "vitest";
import { runMessagingTest } from "../../test/messaging.test-helper.ts";
import { migrate } from "../database.ts";
import { publicCatalog, invalidatePublicCatalog, reloadPublicCatalog } from "./public-catalog.ts";
import type { PublicPersona } from "@ren-ai/onboarding";
import { lookupProfiles } from "./browse.ts";

const profiles = [
  {
    id: "one",
    name: "Public name",
    bio: "Public writing",
    imageUrl: "https://images.test/one.jpg",
  },
];

test("public browsing coalesces first loads, survives actor replacement and never ages into Admin requests", async () => {
  await runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const sql = yield* SqlClient.SqlClient;
      const load = vi.fn<() => Promise<readonly PublicPersona[]>>(async () =>
        profiles.map((persona) => ({ ...persona, privateDescription: "private source" })),
      );
      const cache = yield* publicCatalog(load);
      const results = yield* Effect.all(
        Array.from({ length: 20 }, () => cache.ensure),
        { concurrency: "unbounded" },
      );
      expect(new Set(results).size).toBe(1);
      expect(yield* lookupProfiles(["one"])).toEqual(profiles);
      expect(load).toHaveBeenCalledOnce();
      expect(JSON.stringify(yield* sql`SELECT payload FROM public_catalog`)).not.toContain(
        "private source",
      );
      const [before] = yield* sql<{ n: number }>`SELECT total_changes() AS n`;
      const replacement = yield* publicCatalog(load);
      yield* TestClock.adjust("1 day");
      expect(yield* replacement.ensure).toBe(results[0]);
      expect(yield* sql`SELECT total_changes() AS n`).toEqual([before]);
      expect(load).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("bounded maintenance replaces the served snapshot, writes only its schedule when unchanged and leaves browsing up while Admin fails", async () => {
  await runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const sql = yield* SqlClient.SqlClient;
      let failing = false;
      let candidates: readonly PublicPersona[] = profiles;
      const load = vi.fn<() => Promise<readonly PublicPersona[]>>(async () => {
        if (failing)
          throw Object.assign(new Error("private upstream payload"), {
            code: "CATALOG_HTTP",
            upstreamStatus: 503,
          });
        return candidates;
      });
      const cache = yield* publicCatalog(load);
      const revision = yield* cache.ensure;
      failing = true;
      const failure = yield* cache.maintain.pipe(Effect.flip);
      expect(failure.message).toBe("Public Catalog unavailable");
      expect(yield* sql`SELECT name FROM application_clock WHERE name = 'catalog.public'`).toEqual(
        [],
      );
      yield* TestClock.adjust("1 hour");
      expect(yield* cache.ensure).toBe(revision);
      expect(load).toHaveBeenCalledTimes(2);
      failing = false;
      const [before] = yield* sql<{ n: number }>`SELECT total_changes() AS n`;
      yield* cache.maintain;
      const [after] = yield* sql<{ n: number }>`SELECT total_changes() AS n`;
      expect(after!.n - before!.n).toBe(1); // the persisted maintenance clock only
      yield* TestClock.adjust("4 minutes");
      candidates = [...profiles, { ...profiles[0]!, id: "two" }];
      yield* cache.maintain;
      expect(load).toHaveBeenCalledTimes(3);
      expect(yield* cache.ensure).toBe(revision);
      yield* TestClock.adjust("1 minute");
      yield* cache.maintain;
      const latest = yield* cache.ensure;
      expect(latest).not.toBe(revision);
      expect((yield* lookupProfiles(["two"])).map((persona) => persona.id)).toEqual(["two"]);
      expect(load).toHaveBeenCalledTimes(4);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test.each([false, true])(
  "Admin's change notification fences in-flight loads and schedules an immediate reload (failure: %s)",
  async (failed) => {
    await runMessagingTest(
      Effect.gen(function* () {
        yield* migrate;
        const sql = yield* SqlClient.SqlClient;
        let paused = false;
        const entered = Deferred.makeUnsafe<void>();
        const gate = Deferred.makeUnsafe<readonly PublicPersona[], Error>();
        const cache = yield* publicCatalog(() => {
          if (!paused) return Promise.resolve(profiles);
          Effect.runSync(Deferred.succeed(entered, undefined));
          return Effect.runPromise(Deferred.await(gate));
        });
        yield* cache.ensure;
        yield* cache.maintain;
        paused = true;
        yield* reloadPublicCatalog;
        const now = yield* Clock.currentTimeMillis;
        expect(
          yield* sql`SELECT name FROM application_clock WHERE name = 'catalog.public'`,
        ).toEqual([]);
        expect(yield* sql`SELECT due FROM application_work WHERE name = 'maintenance'`).toEqual([
          { due: now },
        ]);
        const reading = yield* cache.ensure.pipe(Effect.flip, Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* invalidatePublicCatalog;
        if (failed) yield* Deferred.fail(gate, new Error("Upstream unavailable"));
        else yield* Deferred.succeed(gate, profiles);
        expect(yield* Fiber.join(reading)).toBeInstanceOf(Error);
        expect(yield* sql`SELECT payload, generation FROM public_catalog`).toEqual([
          { payload: null, generation: 2 },
        ]);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  },
);

test("invalid sources fail safely and browsing reads its indexed projection without decoding the full stored payload", async () => {
  await runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const invalid = yield* publicCatalog(async () => [{ ...profiles[0]!, bio: "" }]);
      expect((yield* invalid.ensure.pipe(Effect.flip)).message).toBe(
        "Invalid public Catalog response",
      );
      const cache = yield* publicCatalog(async () => profiles);
      const revision = yield* cache.ensure;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE public_catalog SET payload = '{'`;
      expect(yield* cache.ensure).toBe(revision);
      expect(yield* lookupProfiles(["one"])).toEqual(profiles);
      yield* cache.maintain;
      expect(yield* cache.ensure).toBe(revision);
      expect(yield* sql`SELECT payload FROM public_catalog`).toEqual([
        { payload: JSON.stringify(profiles) },
      ]);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
