import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoveryNotice } from "@ren-ai/onboarding";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { expect, test } from "vitest";
import { Schema } from "effect";
import { contactEntries, stopRuntimes, trackRuntime } from "../test/cloudflare-test-fixture.ts";

const workerSource = async () => {
  const buildResult = await build({
    entryPoints: [new URL("../test/application-store-worker.ts", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    external: ["cloudflare:workers", "node:*"],
    write: false,
  });
  return buildResult.outputFiles[0]!.text;
};

const openRuntime = async (resourcePersistencePath: string) => {
  const source = await workerSource();
  const runtime = new Miniflare({
    resourcePersistencePath,
    workers: [
      {
        config: {
          name: "application-store-test",
          compatibilityDate: "2026-10-11",
          compatibilityFlags: ["nodejs_compat"],
          exports: { Registry: { type: "durable-object", storage: "sqlite" } },
          manifest: {
            mainModule: "index.js",
            modules: { "index.js": { type: "esm", contents: source } },
          },
          env: {
            TOKEN_MANAGEMENT: { type: "text", value: "management-test" },
            REGISTRY: {
              type: "durable-object",
              worker: "application-store-test",
              exportName: "Registry",
            },
          },
        },
      },
    ],
  });
  return trackRuntime(runtime);
};

const call = (runtime: Miniflare, path: string, init?: Parameters<Miniflare["dispatchFetch"]>[1]) =>
  runtime.dispatchFetch(`http://application.test${path}`, init);

test("usage collection has a bounded SQL budget and unchanged history incurs no writes after replacement", async () => {
  const persistence = await mkdtemp(join(tmpdir(), "api-usage-budget-"));
  try {
    const runtime = await openRuntime(persistence);
    const response = await call(runtime, "/__fixture/usage-budget");
    expect(response.status).toBe(200);
    const result = Schema.decodeUnknownSync(
      Schema.Struct({
        initial: Schema.Struct({ reads: Schema.Number, writes: Schema.Number }),
        idle: Schema.Struct({ reads: Schema.Number, writes: Schema.Number }),
        changed: Schema.Struct({ reads: Schema.Number, writes: Schema.Number }),
        unchanged: Schema.Struct({ reads: Schema.Number, writes: Schema.Number }),
        input: Schema.Number,
      }),
    )(await response.json());
    process.stdout.write(`Usage SQL budget: ${JSON.stringify(result)}\n`);
    expect(result.initial.reads).toBeLessThan(1000);
    expect(result.idle.reads).toBeLessThan(20);
    expect(result.idle.writes).toBe(0);
    expect(result.changed.reads).toBeLessThan(1000);
    expect(result.changed.writes).toBeLessThan(20);
    expect(result.unchanged.reads).toBeLessThan(20);
    expect(result.unchanged.writes).toBe(0);
    expect(result.input).toBe(11);
    const outbox = await call(runtime, "/__fixture/outbox-budget");
    expect(outbox.status).toBe(200);
    const budgets = Schema.decodeUnknownSync(
      Schema.Array(
        Schema.Struct({
          size: Schema.Number,
          reads: Schema.Number,
          writes: Schema.Number,
          plan: Schema.Array(Schema.Struct({ detail: Schema.String })),
        }),
      ),
    )(await outbox.json());
    expect(budgets.map(({ size }) => size)).toEqual([100, 10000]);
    for (const budget of budgets) {
      expect(budget.reads).toBeLessThanOrEqual(2);
      expect(budget.writes).toBe(0);
      expect(budget.plan.some(({ detail }) => detail.includes("USING INDEX send_pending"))).toBe(
        true,
      );
      expect(budget.plan.some(({ detail }) => detail.includes("TEMP B-TREE"))).toBe(false);
    }
  } finally {
    await stopRuntimes();
    await rm(persistence, { recursive: true, force: true });
  }
});
const register = (runtime: Miniflare, handle: string) =>
  call(runtime, "/discovery/waitlist", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": handle },
    body: JSON.stringify({
      handle,
      locale: "ko",
      privacyNoticeVersion: discoveryNotice.version,
      turnstileToken: "human",
      name: "Visitor",
      likedPersonaIDs: ["sora"],
    }),
  });

test("registry persists state on the Durable Object across recreation", async () => {
  const persistence = await mkdtemp(join(tmpdir(), "api-app-store-"));
  try {
    let runtime = await openRuntime(persistence);
    const migrated = await call(runtime, "/__fixture/legacy-registration");
    expect(migrated.status).toBe(200);
    expect(await migrated.json()).toEqual({
      registrations: [
        { id: "original", archived_at: 200 },
        { id: "next", archived_at: null },
      ],
      likes: [{ registration_id: "original", persona_id: "seoyul" }],
      languages: [{ registration_id: "original", conversation_language: "ko" }],
      contacts: [
        {
          registration_id: "original",
          persona_id: "seoyul",
          selection_id: "selection-original",
          state: "active",
        },
      ],
      violations: [],
    });
    const profiles = await call(runtime, "/discovery/personas");
    expect(profiles.status).toBe(200);
    expect(await profiles.json()).toHaveLength(2);
    expect((await register(runtime, "+821012345678")).status).toBe(200);
    expect((await register(runtime, "+821012345678")).status).toBe(200);
    expect((await register(runtime, "+821087654321")).status).toBe(200);
    expect(
      (
        await call(runtime, "/management/discovery", {
          headers: { Authorization: "Bearer management-test" },
        })
      ).status,
    ).toBe(200);
    const listing = await call(runtime, "/management/discovery", {
      headers: { Authorization: "Bearer management-test" },
    });
    const listed = await contactEntries(() => listing.text());
    expect(listed.entries).toHaveLength(2);
    const registrationID = listed.entries.find((entry) => entry.handle === "+821012345678")!.id;
    const otherRegistrationID = listed.entries.find(
      (entry) => entry.handle === "+821087654321",
    )!.id;
    const auth = { Authorization: "Bearer management-test", "Content-Type": "application/json" };
    expect(
      (
        await call(runtime, "/__fixture/test-handle", {
          method: "POST",
          body: JSON.stringify({ handle: "+821012345678" }),
        })
      ).status,
    ).toBe(200);
    const start = (personaID: string) =>
      call(runtime, "/management/discovery/start", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          requestId: "00000000-0000-4000-8000-000000000001",
          registrationID,
          personaID,
        }),
      });
    expect((await start("missing")).status).toBe(409);
    expect((await start("sora")).status).toBe(409);
    expect((await call(runtime, "/__fixture/verify-imessage")).status).toBe(200);
    expect((await start("sora")).status).toBe(200);
    expect((await start("sora")).status).toBe(200);

    const selection = {
      requestId: "00000000-0000-4000-8000-000000000002",
      count: 1,
    };
    const select = (body: typeof selection) =>
      call(runtime, "/management/discovery/select", {
        method: "POST",
        headers: auth,
        body: JSON.stringify(body),
      });
    const firstSelection = await select(selection);
    expect(firstSelection.status).toBe(200);
    const replayedSelection = await select(selection);
    expect(replayedSelection.status).toBe(200);
    expect(await replayedSelection.json()).toEqual(await firstSelection.json());
    expect((await select({ ...selection, count: 2 })).status).toBe(409);
    expect((await call(runtime, "/discovery/unknown")).status).toBe(404);
    expect((await call(runtime, "/discovery/images/test.jpg")).status).toBe(404);
    expect((await call(runtime, "/unknown")).status).toBe(404);

    const state = await call(runtime, "/__fixture/state");
    const persisted = await state.json();
    expect(persisted).toEqual({
      registrations: [
        { id: registrationID, handle: "+821012345678" },
        { id: otherRegistrationID, handle: "+821087654321" },
      ].toSorted((left, right) => left.handle.localeCompare(right.handle)),
      selections: [
        { requestId: "00000000-0000-4000-8000-000000000001" },
        { requestId: "00000000-0000-4000-8000-000000000002" },
      ],
      assignments: [
        { personaID: "sora", handle: "+821012345678" },
        { personaID: "sora", handle: "+821087654321" },
      ],
    });

    await stopRuntimes();
    runtime = await openRuntime(persistence);
    const restored = await call(runtime, "/management/discovery", {
      headers: { Authorization: "Bearer management-test" },
    });
    const restoredList = await contactEntries(() => restored.text());
    expect(restoredList.entries).toHaveLength(2);
    expect(restoredList.entries.some((entry) => entry.id === registrationID)).toBe(true);
    expect(await (await call(runtime, "/__fixture/state")).json()).toEqual(persisted);
    const reopened = await call(runtime, "/__fixture/reopen-conflict", { method: "POST" });
    expect(reopened.status).toBe(200);
    expect(await reopened.json()).toEqual({ initialized: true });
    const sharedStartup = await call(runtime, "/management/discovery", {
      headers: { Authorization: "Bearer management-test" },
    });
    expect(sharedStartup.status).toBe(200);
    expect(await (await call(runtime, "/__fixture/state")).json()).toEqual(persisted);
  } finally {
    await stopRuntimes();
    await rm(persistence, { recursive: true, force: true });
  }
});
