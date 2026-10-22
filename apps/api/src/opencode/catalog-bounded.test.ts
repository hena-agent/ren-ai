import { Clock, Deferred, Effect, Fiber, Schema } from "effect";
import { AbsolutePath, Session } from "@opencode/schema";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { catalogTest } from "./catalog-sync.test-helper.ts";
import { syncFolders } from "./catalog-sync.ts";
import { claimWork, DeferredWork, withWorkBudget } from "../work-budget.ts";
import { registration } from "../../test/messaging.test-helper.ts";

test(
  "Catalog preflight checkpoints survive an expired alarm budget before applying a complete revision",
  catalogTest((host, fixture) =>
    Effect.gen(function* () {
      const active = yield* host.activeSession();
      const before = yield* host.read(active.id);
      const updated = new Map(host.personas);
      updated.set("persona1", {
        ...updated.get("persona1")!,
        prompt: "You enjoy the quiet observatory.",
      });
      const entered = yield* Deferred.make<void>();
      let slow = true;
      const client = {
        ...host.remote.client,
        session: {
          ...host.remote.client.session,
          get: (input: Parameters<typeof host.remote.client.session.get>[0]) =>
            Effect.gen(function* () {
              if (slow) {
                slow = false;
                yield* Deferred.succeed(entered, undefined);
                yield* Effect.sleep("46 seconds");
              }
              return yield* host.remote.client.session.get(input);
            }),
        },
      };
      const scan = yield* withWorkBudget(
        syncFolders(client, fixture.personaDirectory, updated, fixture.groundRules),
      ).pipe(Effect.flip, Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("46 seconds");
      expect(yield* Fiber.join(scan)).toBeInstanceOf(DeferredWork);
      expect(yield* host.read(active.id)).toEqual(before);
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT name FROM application_checkpoint`).toEqual([
        { name: "catalog.sync" },
      ]);
      yield* withWorkBudget(
        syncFolders(client, fixture.personaDirectory, updated, fixture.groundRules),
      ).pipe(Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()));
      const after = yield* host.read(active.id);
      expect(after.persona.prompt).toBe("You enjoy the quiet observatory.");
      expect(after.runtime).toEqual(before.runtime);
      expect(yield* sql`SELECT name FROM application_checkpoint`).toEqual([]);
    }).pipe(Effect.provide(TestClock.layer())),
  ),
);

test.each([35, 36])(
  "Catalog resumption retains native offsets and restarts validation for changed input (%s prior admissions)",
  (admissions) =>
    catalogTest((host, fixture) =>
      Effect.gen(function* () {
        const active = yield* host.activeSession();
        const other = Schema.decodeUnknownSync(Session.Info)({
          ...Schema.encodeSync(Session.Info)(active),
          id: Session.ID.make("ses_unmanaged"),
          location: { directory: AbsolutePath.make("/unmanaged") },
        });
        const client = {
          ...host.remote.client,
          session: {
            ...host.remote.client.session,
            list: () => Effect.succeed({ data: [active, other], cursor: {} }),
          },
        };
        const personas = new Map(host.personas);
        const paused = yield* withWorkBudget(
          Effect.forEach(Array.from({ length: admissions }), () => claimWork).pipe(
            Effect.andThen(
              syncFolders(client, fixture.personaDirectory, personas, fixture.groundRules),
            ),
          ),
        ).pipe(Effect.flip);
        expect(paused).toBeInstanceOf(DeferredWork);
        if (admissions === 35)
          personas.set("persona1", { ...personas.get("persona1")!, name: "Updated public name" });
        yield* withWorkBudget(
          syncFolders(client, fixture.personaDirectory, personas, fixture.groundRules),
        );
        const sql = yield* SqlClient.SqlClient;
        expect(yield* sql`SELECT 1 FROM application_checkpoint`).toEqual([]);
      }).pipe(Effect.provide(TestClock.layer())),
    )(),
);

test(
  "Catalog pagination validates every page, rejects loops, prunes deleted plans, and refreshes retained shared roots",
  catalogTest((host, fixture) =>
    Effect.gen(function* () {
      const active = yield* host.activeSession();
      const before = yield* host.read(active.id);
      const cursor = Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("SessionsCursor")))(
        "next",
      );
      let looping = true;
      const client = {
        ...host.remote.client,
        session: {
          ...host.remote.client.session,
          list: (input: Parameters<typeof host.remote.client.session.list>[0]) =>
            Effect.succeed({
              data: input?.cursor ? [] : [active],
              cursor: looping || !input?.cursor ? { next: cursor } : {},
            }),
        },
      };
      expect(
        (yield* syncFolders(
          client,
          fixture.personaDirectory,
          host.personas,
          fixture.groundRules,
        ).pipe(Effect.flip)).message,
      ).toContain("pagination did not advance");
      expect(yield* host.read(active.id)).toEqual(before);
      looping = false;
      for (let i = 0; i < 4; i++)
        yield* host.directory.create({
          ...registration(`missing-${i}@example.test`, `ses_absent_${i}`),
          personaID: `missing-${i}`,
        });
      host.personas.set("persona1", {
        ...host.personas.get("persona1")!,
        prompt: "Updated shared identity.",
      });
      yield* withWorkBudget(
        syncFolders(client, fixture.personaDirectory, host.personas, fixture.groundRules),
      );
      const sql = yield* SqlClient.SqlClient;
      const [plan] = yield* sql<{
        fingerprint: string;
      }>`SELECT fingerprint FROM catalog_plan LIMIT 1`;
      yield* sql`INSERT INTO catalog_plan VALUES ('ses_deleted', ${plan!.fingerprint + "-deleted"}, 'deleted-persona')`;
      yield* sql`INSERT INTO retained_session(session_id, handle, title) VALUES (${active.id}, 'retained', 'retained')`;
      yield* syncFolders(client, fixture.personaDirectory, host.personas, fixture.groundRules);
      expect(yield* sql`SELECT 1 FROM catalog_plan WHERE session_id = 'ses_deleted'`).toEqual([]);
      const after = yield* host.read(active.id);
      expect(after).toMatchObject({
        persona: { prompt: "Updated shared identity." },
        relationship: before.relationship,
      });
      expect(after.runtime).toEqual(before.runtime);
    }),
  ),
);

test(
  "bounded Catalog resumption applies each shared root once and leaves unchanged plans unwritten",
  catalogTest((host, fixture) =>
    Effect.gen(function* () {
      for (const persona of ["persona1", "harin"])
        for (let index = 0; index < 4; index++)
          yield* host.activeSession(persona, `${persona}-${index}@example.test`);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE catalog_plan_writes (operation TEXT NOT NULL)`;
      yield* sql`CREATE TRIGGER catalog_plan_insert AFTER INSERT ON catalog_plan BEGIN
        INSERT INTO catalog_plan_writes VALUES ('insert'); END`;
      yield* sql`CREATE TRIGGER catalog_plan_update AFTER UPDATE ON catalog_plan BEGIN
        INSERT INTO catalog_plan_writes VALUES ('update'); END`;
      const updated = new Map(
        [...host.personas].map(([id, persona]) => [
          id,
          { ...persona, prompt: `${persona.prompt}\nYou enjoy the shared observatory.` },
        ]),
      );
      let writes = 0;
      host.transport.before = (request) => {
        if (new URL(request.url).pathname.endsWith("/update")) writes++;
        return Promise.resolve();
      };
      const paused = yield* withWorkBudget(
        Effect.forEach(Array.from({ length: 20 }), () => claimWork).pipe(
          Effect.andThen(
            syncFolders(host.remote.client, fixture.personaDirectory, updated, fixture.groundRules),
          ),
        ),
      ).pipe(Effect.flip);
      expect(paused).toBeInstanceOf(DeferredWork);
      expect(writes).toBe(0);
      yield* withWorkBudget(
        syncFolders(host.remote.client, fixture.personaDirectory, updated, fixture.groundRules),
      );
      expect(writes).toBe(2);
      expect(yield* sql`SELECT persona_id FROM catalog_plan ORDER BY persona_id`).toEqual([
        { persona_id: "harin" },
        { persona_id: "persona1" },
      ]);
      expect(yield* sql`SELECT operation FROM catalog_plan_writes`).toEqual([
        { operation: "insert" },
        { operation: "insert" },
      ]);
      yield* withWorkBudget(
        syncFolders(host.remote.client, fixture.personaDirectory, updated, fixture.groundRules),
      );
      expect(writes).toBe(2);
      expect(yield* sql`SELECT operation FROM catalog_plan_writes`).toHaveLength(2);
      expect(
        JSON.stringify(
          yield* sql`EXPLAIN QUERY PLAN SELECT session_id, persona_id, fingerprint
        FROM catalog_plan WHERE fingerprint >= 'revision:' AND fingerprint < 'revision;'
        AND fingerprint > '' ORDER BY fingerprint LIMIT 5`,
        ),
      ).toContain("catalog_plan_scan");
    }),
  ),
);

test(
  "a missing persona recovered during preflight is durable before a replacement actor continues",
  catalogTest((host, fixture) =>
    Effect.gen(function* () {
      const active = yield* host.activeSession();
      const sql = yield* SqlClient.SqlClient;
      const missing = new Map(host.personas);
      missing.delete("persona1");
      yield* sql`INSERT INTO runtime_catalog(id, revision, payload) VALUES (1, 'revision', ${JSON.stringify([...missing.values()])})`;
      yield* withWorkBudget(
        syncFolders(host.remote.client, fixture.personaDirectory, missing, fixture.groundRules),
      );
      expect(missing.has("persona1")).toBe(true);
      expect(JSON.stringify(yield* sql`SELECT payload FROM runtime_catalog`)).toContain("persona1");
      expect((yield* host.read(active.id)).persona.id).toBe("persona1");
    }),
  ),
);
