import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";
import { expect, test, vi } from "vitest";
import { runMessagingTest } from "../../test/messaging.test-helper.ts";
import { migrate } from "../database.ts";
import { publicCatalog, invalidatePublicCatalog } from "./public-catalog.ts";
import type { PublicPersona } from "@ren-ai/onboarding";
import type { ContactDiagnostic } from "../discovery/diagnostics.ts";

const profiles = [
  {
    id: "one",
    name: "Public name",
    bio: "Public writing",
    imageUrl: "https://images.test/one.jpg",
  },
];

test("public browsing coalesces requests, survives actor replacement and keeps idle checkpoints write-free", async () => {
  await runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const sql = yield* SqlClient.SqlClient;
      const load = vi.fn<() => Promise<readonly PublicPersona[]>>(async () =>
        profiles.map((persona) => ({ ...persona, privateDescription: "private source" })),
      );
      const cache = yield* publicCatalog(load);
      const results = yield* Effect.all(
        Array.from({ length: 20 }, (_, i) => cache.read(`request-${i}`)),
        { concurrency: "unbounded" },
      );
      expect(results).toEqual(Array.from({ length: 20 }, () => profiles));
      expect(load).toHaveBeenCalledOnce();
      expect(JSON.stringify(yield* sql`SELECT payload FROM public_catalog`)).not.toContain(
        "private source",
      );
      const [before] = yield* sql<{ n: number }>`SELECT total_changes() AS n`;
      const replacement = yield* publicCatalog(load);
      expect(yield* replacement.read("replacement")).toEqual(profiles);
      expect(yield* sql`SELECT total_changes() AS n`).toEqual([before]);
      expect(load).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("stale browsing has a hard expiry, backs off failed refreshes and emits private-data-free diagnostics", async () => {
  await runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      let failing = false;
      const logs: ContactDiagnostic[] = [];
      const load = vi.fn<() => Promise<readonly PublicPersona[]>>(async () => {
        if (failing)
          throw Object.assign(new Error("private upstream payload"), {
            code: "CATALOG_HTTP",
            upstreamStatus: 503,
          });
        return profiles;
      });
      const cache = yield* publicCatalog(load, (event) => logs.push(event));
      yield* cache.read("first");
      failing = true;
      yield* TestClock.adjust("60 seconds");
      expect(yield* cache.read("stale")).toEqual(profiles);
      yield* TestClock.adjust("5 seconds");
      yield* cache.read("retry-window");
      expect(load).toHaveBeenCalledTimes(2);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        requestId: "stale",
        stage: "catalog.stale",
        level: "warn",
        causeCode: "CATALOG_HTTP",
        upstreamStatus: 503,
      });
      expect(JSON.stringify(logs)).not.toContain("private upstream payload");
      yield* TestClock.adjust("6 seconds");
      yield* cache.read("refresh-again");
      expect(load).toHaveBeenCalledTimes(3);
      yield* TestClock.adjust("289 seconds");
      expect((yield* cache.read("expired").pipe(Effect.flip)).message).toBe(
        "Public Catalog unavailable",
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test.each([false, true])(
  "Catalog invalidation fences in-flight refreshes and their stale fallback (failure: %s)",
  async (failed) => {
    await runMessagingTest(
      Effect.gen(function* () {
        yield* migrate;
        let paused = false;
        const entered = Deferred.makeUnsafe<void>();
        const gate = Deferred.makeUnsafe<readonly PublicPersona[], Error>();
        const cache = yield* publicCatalog(() => {
          if (!paused) return Promise.resolve(profiles);
          Effect.runSync(Deferred.succeed(entered, undefined));
          return Effect.runPromise(Deferred.await(gate));
        });
        yield* cache.read("initial");
        paused = true;
        yield* TestClock.adjust("60 seconds");
        const reading = yield* cache.read("racing").pipe(Effect.flip, Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* invalidatePublicCatalog;
        if (failed) yield* Deferred.fail(gate, new Error("Upstream unavailable"));
        else yield* Deferred.succeed(gate, profiles);
        expect(yield* Fiber.join(reading)).toBeInstanceOf(Error);
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`SELECT payload, generation FROM public_catalog`).toEqual([
          { payload: null, generation: 1 },
        ]);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  },
);

test("invalid source and persisted snapshots fail safely and an expired corrupt snapshot can refresh", async () => {
  await runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const invalid = yield* publicCatalog(async () => [{ ...profiles[0]!, bio: "" }]);
      expect((yield* invalid.read("bad-source").pipe(Effect.flip)).message).toBe(
        "Invalid public Catalog response",
      );
      const cache = yield* publicCatalog(async () => profiles);
      yield* cache.read("good");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE public_catalog SET payload = '{'`;
      expect((yield* cache.read("bad-cache").pipe(Effect.flip)).message).toBe(
        "Invalid public Catalog snapshot",
      );
      yield* TestClock.adjust("60 seconds");
      expect(yield* cache.read("refreshed")).toEqual(profiles);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
