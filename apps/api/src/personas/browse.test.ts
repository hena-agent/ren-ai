import { Clock, Effect } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/sql";
import { expect, test, vi } from "vitest";
import type { BrowsePage, PublicPersona } from "@ren-ai/onboarding";
import { runMessagingTest } from "../../test/messaging.test-helper.ts";
import { migrate } from "../database.ts";
import { publicCatalog, invalidatePublicCatalog } from "./public-catalog.ts";
import { browsePage, lookupProfiles } from "./browse.ts";
import { browseLifetime } from "./browse-snapshot.ts";

const persona = (id: string): PublicPersona => ({
  id,
  name: id,
  bio: "Public writing",
  imageUrl: "",
});
const token = (
  revision: string,
  expires: number,
  changes: { locale?: string; tier?: number; segment?: number; seed?: string } = {},
) =>
  Buffer.from(
    JSON.stringify({
      revision,
      expires,
      locale: "ko",
      tier: 0,
      segment: 0,
      seed: "8".repeat(64),
      key: "",
      id: "",
      ...changes,
    }),
  ).toString("base64url");

test("a cursor started during stale service retains its membership for its entire lifetime after the Catalog changes", async () => {
  await runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      let offline = false;
      let candidates = [persona("one")];
      const cache = yield* publicCatalog(
        async () => {
          if (offline) throw new Error("offline");
          return candidates;
        },
        () => {},
      );
      const revision = yield* cache.ensure("initial");
      offline = true;
      yield* TestClock.adjust("359 seconds");
      expect(yield* cache.ensure("stale")).toBe(revision);
      const started = yield* Clock.currentTimeMillis;
      const cursor = token(revision, started + browseLifetime);
      offline = false;
      candidates = [...candidates, persona("two")];
      yield* TestClock.adjust("1 second");
      const latest = yield* cache.ensure("changed");
      yield* TestClock.adjust("3598 seconds");
      const page = yield* browsePage({ locale: "ko", cursor }, latest);
      expect(page.people.map((p) => p.id)).toEqual(["one"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("10,000 candidates use indexed, bounded pages without per-visitor writes and survive actor replacement", async () => {
  const load = vi.fn<() => Promise<readonly PublicPersona[]>>(async () =>
    Array.from({ length: 10_000 }, (_, i) => persona(`p${i}`)),
  );
  await runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const sql = yield* SqlClient.SqlClient;
      const cache = yield* publicCatalog(load);
      const revision = yield* cache.ensure("initial");
      const [before] = yield* sql<{ n: number }>`SELECT total_changes() AS n`;
      const first = yield* browsePage({ locale: "ko" }, revision);
      expect(first.people).toHaveLength(10);
      expect(first.nextCursor).not.toBeNull();
      const replacement = yield* publicCatalog(load);
      expect(yield* replacement.ensure("replacement")).toBe(revision);
      const query = { locale: "ko", cursor: first.nextCursor! } as const;
      const second = yield* browsePage(query, revision);
      expect(yield* browsePage(query, revision)).toEqual(second);
      expect(new Set([...first.people, ...second.people].map((p) => p.id)).size).toBe(20);
      expect(yield* sql`SELECT total_changes() AS n`).toEqual([before]);
      expect(load).toHaveBeenCalledOnce();
      const plan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN
      SELECT p.id, l.payload, p.random_key FROM browse_persona p JOIN browse_live l ON l.id = p.id
      WHERE p.revision = ${revision} AND p.ko = 2 AND p.random_key >= '8' AND p.random_key < 'g'
      AND (p.random_key, p.id) > ('8', '')
      AND NOT EXISTS (SELECT 1 FROM persona_exclusion e WHERE e.handle = '' AND e.persona_id = p.id)
      ORDER BY p.random_key, p.id LIMIT 11`;
      const details = plan.map((row) => row.detail).join("\n");
      expect(details).toContain("browse_ko");
      expect(details).not.toMatch(/SCAN p|TEMP B-TREE/);
      expect(yield* lookupProfiles([first.people[0]!.id, "missing"])).toEqual([first.people[0]]);
      expect(yield* lookupProfiles([])).toEqual([]);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("language tiers exhaust in order, seeded traversal wraps without duplicates, and ended relationships stay excluded", async () => {
  await runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const sql = yield* SqlClient.SqlClient;
      const candidates = Array.from({ length: 35 }, (_, i): PublicPersona => ({
        ...persona(`p${i}`),
        languages: {
          primary: i < 12 ? "ko" : "en",
          proficiency: { ko: i < 24 ? "fluent" : "beginner", en: "fluent" },
        },
      }));
      const cache = yield* publicCatalog(async () => candidates);
      const revision = yield* cache.ensure("start");
      yield* sql`INSERT INTO persona_exclusion VALUES ('visitor', 'p0')`;
      const now = yield* Clock.currentTimeMillis;
      let cursor: string | null = token(revision, now + browseLifetime);
      const seen: PublicPersona[] = [];
      while (cursor) {
        const page: BrowsePage = yield* browsePage({ locale: "ko", cursor }, revision, "visitor");
        expect(page.people.length).toBeLessThanOrEqual(10);
        seen.push(...page.people);
        cursor = page.nextCursor;
      }
      expect(new Set(seen.map((p) => p.id)).size).toBe(34);
      expect(seen.slice(0, 11).every((p) => p.languages?.primary === "ko")).toBe(true);
      expect(seen.slice(11, 23).every((p) => p.languages?.proficiency["ko"] === "fluent")).toBe(
        true,
      );
      expect(seen.slice(23).every((p) => p.languages?.proficiency["ko"] === "beginner")).toBe(true);
      expect(yield* lookupProfiles(["p0", "p1"], "visitor")).toEqual([candidates[1]]);
      const english = yield* browsePage({ locale: "en" }, revision);
      expect(english.people.every((p) => p.languages?.primary === "en")).toBe(true);
      const japanese = yield* browsePage({ locale: "ja" }, revision);
      expect(japanese.people).toHaveLength(10);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("catalog edits preserve traversal membership and language tiers, update live profiles, and remove unpublished candidates", async () => {
  await runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const sql = yield* SqlClient.SqlClient;
      let candidates = Array.from({ length: 25 }, (_, i) => persona(`p${i}`));
      const cache = yield* publicCatalog(async () => candidates);
      const revision = yield* cache.ensure("initial");
      const now = yield* Clock.currentTimeMillis;
      const cursor = token(revision, now + browseLifetime);
      const initial = yield* browsePage({ locale: "ko", cursor }, revision);
      const removed = initial.people[0]!.id;
      const edited = initial.people[1]!.id;
      candidates = candidates
        .filter((p) => p.id !== removed)
        .map((p) => (p.id === edited ? { ...p, bio: "Updated writing" } : p));
      candidates.push(persona("new"));
      yield* invalidatePublicCatalog;
      const nextRevision = yield* cache.ensure("updated");
      expect(nextRevision).not.toBe(revision);
      const replay = yield* browsePage({ locale: "ko", cursor }, nextRevision);
      expect(replay.people.some((p) => p.id === removed || p.id === "new")).toBe(false);
      expect(replay.people.find((p) => p.id === edited)?.bio).toBe("Updated writing");
      const [before] = yield* sql<{ n: number }>`SELECT total_changes() AS n`;
      yield* TestClock.adjust("60 seconds");
      expect(yield* cache.ensure("unchanged")).toBe(nextRevision);
      const [after] = yield* sql<{ n: number }>`SELECT total_changes() AS n`;
      expect(after!.n - before!.n).toBe(2); // refresh metadata only; no profile or membership rewrites
      yield* sql`UPDATE browse_live SET payload = '{' WHERE id = ${edited}`;
      expect((yield* lookupProfiles([edited]).pipe(Effect.flip)).message).toBe(
        "Invalid stored public profile",
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("malformed, mismatched, expired and missing-snapshot cursors fail explicitly; empty catalogs terminate", async () => {
  await runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const cache = yield* publicCatalog(async () => []);
      const revision = yield* cache.ensure("empty");
      const now = yield* Clock.currentTimeMillis;
      expect(yield* browsePage({ locale: "ko" }, revision)).toEqual({
        people: [],
        nextCursor: null,
      });
      for (const cursor of [
        "bad",
        token(revision, now),
        token(revision, now + browseLifetime + 1),
        token(revision, now + 100, { locale: "en" }),
        token("0".repeat(64), now + 100),
      ])
        expect(yield* browsePage({ locale: "ko", cursor }, revision).pipe(Effect.flip)).toBe(
          "personas",
        );
      yield* TestClock.adjust("2 hours");
      expect(yield* cache.ensure("renewed")).toBe(revision);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
