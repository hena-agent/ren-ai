import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrowsePage,
  ContactSnapshot,
  discoveryNotice,
  Metrics,
  MetricTotal,
  koreaDay,
} from "@ren-ai/onboarding";
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
          exports: {
            Registry: { type: "durable-object", storage: "sqlite" },
            ActivityStore: { type: "durable-object", storage: "sqlite" },
          },
          manifest: {
            mainModule: "index.js",
            modules: { "index.js": { type: "esm", contents: source } },
          },
          env: {
            TOKEN_MANAGEMENT: { type: "text", value: "management-test" },
            ACTIVITY_STORE: {
              type: "durable-object",
              worker: "application-store-test",
              exportName: "ActivityStore",
            },
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

test("activity cardinality is bounded without Visit reports and concurrent reports lose no totals", async () => {
  const persistence = await mkdtemp(join(tmpdir(), "metrics-activity-budget-"));
  const day = koreaDay(Date.now());
  const path = `/__activity/?from=${day}&to=${day}`;
  try {
    const runtime = await openRuntime(persistence);
    await call(runtime, path);
    const report = (index: number) =>
      call(runtime, "/__activity/", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-IPCountry": "KR" },
        body: JSON.stringify({
          step: "like",
          source: {
            entry: "home",
            referrer: "",
            source: `campaign-${index}`,
            medium: "",
            campaign: "",
          },
          persona: `persona-${index}`,
          device: "phone",
          locale: "ko",
          imageStyle: "anime",
        }),
      });
    for (let index = 0; index < 300; index++) {
      const response = await report(index);
      expect(response.status).toBe(204);
      expect(Number(response.headers.get("X-Rows-Read"))).toBeLessThan(30);
      expect(Number(response.headers.get("X-Rows-Written"))).toBeLessThan(30);
    }
    const concurrent = await Promise.all(Array.from({ length: 20 }, () => report(0)));
    expect(concurrent.every((response) => response.status === 204)).toBe(true);
    const totals = Schema.decodeUnknownSync(Schema.Array(MetricTotal))(
      await (await call(runtime, path)).json(),
    );
    expect(totals).toEqual([{ day, step: "like", dimension: "total", value: "", count: 320 }]);
    for (const breakdown of ["source", "persona"]) {
      const rows = Schema.decodeUnknownSync(Schema.Array(MetricTotal))(
        await (await call(runtime, `${path}&breakdown=${breakdown}`)).json(),
      );
      expect(rows).toHaveLength(257);
      expect(rows.find((row) => row.value === "other")?.count).toBe(44);
    }
    const idle = await call(runtime, path);
    expect(Number(idle.headers.get("X-Rows-Written"))).toBe(0);
    expect(Number(idle.headers.get("X-Rows-Read"))).toBeLessThan(5);
  } finally {
    await stopRuntimes();
    await rm(persistence, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "a zero Report queues once per Korea-time day and cooldown global=%s survives replacement",
  async (global) => {
    const persistence = await mkdtemp(join(tmpdir(), "metrics-discord-"));
    const at = Date.now();
    const day = koreaDay(at);
    const posts = Schema.Array(Schema.Struct({ content: Schema.String, wait: Schema.String }));
    try {
      let runtime = await openRuntime(persistence);
      const first = Schema.decodeUnknownSync(posts)(
        await (
          await call(
            runtime,
            `/__fixture/metrics-tick?at=${at}&status=429${global ? "&global" : ""}`,
          )
        ).json(),
      );
      expect(first).toHaveLength(1);
      expect(first[0]!.wait).toBe("true");
      expect(first[0]!.content).toContain("방문: 0 / 0");
      expect(first[0]!.content).toContain("https://admin.renai.im/metrics");
      expect(first[0]!.content.length).toBeLessThanOrEqual(2000);
      await stopRuntimes();
      runtime = await openRuntime(persistence);
      const state = await call(runtime, `/management/metrics?from=${day}&to=${day}`, {
        headers: { Authorization: "Bearer management-test" },
      });
      expect(Schema.decodeUnknownSync(Metrics)(await state.json()).delivery).toMatchObject({
        reports: "rejected",
        pending: 1,
      });
      expect(
        await (
          await call(
            runtime,
            `/__fixture/metrics-tick?at=${at + 119_000}${global ? "&alerts=1" : ""}`,
          )
        ).json(),
      ).toEqual([]);
      const retried = Schema.decodeUnknownSync(posts)(
        await (await call(runtime, `/__fixture/metrics-tick?at=${at + 120_000}`)).json(),
      );
      expect(retried).toHaveLength(global ? 3 : 1);
      expect(retried).toEqual(expect.arrayContaining([...first]));
      expect(
        await (await call(runtime, `/__fixture/metrics-tick?at=${at + 121_000}`)).json(),
      ).toEqual([]);
      await stopRuntimes();
      runtime = await openRuntime(persistence);
      const late = Schema.decodeUnknownSync(posts)(
        await (await call(runtime, `/__fixture/metrics-tick?at=${at + 86_400_000}`)).json(),
      );
      expect(late).toHaveLength(1);
      expect(late[0]!.content).not.toBe(first[0]!.content);
    } finally {
      await stopRuntimes();
      await rm(persistence, { recursive: true, force: true });
    }
  },
);

test("Report failures leave Alert delivery independent and webhook cooldown survives replacement", async () => {
  const persistence = await mkdtemp(join(tmpdir(), "metrics-isolation-"));
  const at = Date.now();
  const posts = Schema.Array(Schema.Struct({ content: Schema.String, wait: Schema.String }));
  try {
    let runtime = await openRuntime(persistence);
    const first = await call(
      runtime,
      `/__fixture/metrics-tick?at=${at}&status=429&alerts=1&activity=fail`,
    );
    expect(first.status).toBe(200);
    expect(Schema.decodeUnknownSync(posts)(await first.json())).toHaveLength(1);
    await stopRuntimes();
    runtime = await openRuntime(persistence);
    const backingOff = await call(runtime, `/__fixture/metrics-tick?at=${at + 500}&activity=fail`);
    expect(await backingOff.json()).toEqual([]);
    expect(backingOff.headers.get("X-Activity-Reads")).toBe("0");
    expect(
      await (
        await call(runtime, `/__fixture/metrics-tick?at=${at + 119_000}&activity=fail`)
      ).json(),
    ).toEqual([]);
    const delivered = Schema.decodeUnknownSync(posts)(
      await (
        await call(runtime, `/__fixture/metrics-tick?at=${at + 120_000}&activity=fail`)
      ).json(),
    );
    expect(delivered).toHaveLength(2);
    expect(delivered.every((post) => post.content.includes("https://admin.renai.im/"))).toBe(true);
  } finally {
    await stopRuntimes();
    await rm(persistence, { recursive: true, force: true });
  }
});

test("usage collection has a bounded SQL budget and unchanged history incurs no writes after replacement", async () => {
  const persistence = await mkdtemp(join(tmpdir(), "api-usage-budget-"));
  try {
    const runtime = await openRuntime(persistence);
    const metrics = Schema.decodeUnknownSync(
      Schema.Struct({
        idle: Schema.Struct({ reads: Schema.Number, writes: Schema.Number }),
        small: Schema.Struct({ reads: Schema.Number, writes: Schema.Number }),
        large: Schema.Struct({ reads: Schema.Number, writes: Schema.Number }),
        smallQueue: Schema.Struct({ reads: Schema.Number, writes: Schema.Number }),
        largeQueue: Schema.Struct({ reads: Schema.Number, writes: Schema.Number }),
        queuePlan: Schema.Array(Schema.Struct({ detail: Schema.String })),
        statuses: Schema.Array(Schema.Number),
        plan: Schema.Array(Schema.Struct({ detail: Schema.String })),
      }),
    )(await (await call(runtime, "/__fixture/metrics-budget")).json());
    expect(metrics.statuses).toEqual([200, 200]);
    expect(metrics.idle.writes).toBe(0);
    expect(metrics.idle.reads).toBeLessThan(100);
    expect(metrics.large.writes).toBe(0);
    expect(metrics.large.reads).toBeLessThanOrEqual(metrics.small.reads + 5);
    expect(metrics.plan.some(({ detail }) => detail.includes("metric_read"))).toBe(true);
    expect(metrics.largeQueue.reads).toBeLessThanOrEqual(metrics.smallQueue.reads + 10);
    expect(metrics.largeQueue.writes).toBeLessThan(50);
    expect(metrics.queuePlan.some(({ detail }) => detail.includes("discord_channel_due"))).toBe(
      true,
    );
    expect(metrics.queuePlan.every(({ detail }) => !detail.includes("TEMP B-TREE"))).toBe(true);
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

test.each([false, true])(
  "blocked admission during creation=%s commits without an uncertain Greeting",
  async (during) => {
    const persistence = await mkdtemp(join(tmpdir(), "metrics-blocked-"));
    try {
      const runtime = await openRuntime(persistence);
      expect((await register(runtime, "+821012345678")).status).toBe(200);
      await call(runtime, "/__fixture/verify-imessage");
      const headers = {
        Authorization: "Bearer management-test",
        "Content-Type": "application/json",
      };
      expect(
        (
          await call(runtime, "/management/discovery/select", {
            method: "POST",
            headers,
            body: JSON.stringify({ requestId: crypto.randomUUID(), count: 1 }),
          })
        ).status,
      ).toBe(200);
      const result = await call(runtime, `/__fixture/blocked-contact${during ? "?during" : ""}`);
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ created: Number(during), removed: Number(during) });
      const listing = await call(runtime, "/management/discovery", { headers });
      expect(
        Schema.decodeUnknownSync(ContactSnapshot)(await listing.json()).entries[0]!.state,
      ).toBe("blocked");
      const day = koreaDay(Date.now());
      const metrics = Schema.decodeUnknownSync(Metrics)(
        await (
          await call(runtime, `/management/metrics?from=${day}&to=${day}`, { headers })
        ).json(),
      );
      expect(metrics.alerts).toEqual([]);
      expect(metrics.totals.some((row) => row.step === "greeting_uncertain")).toBe(false);
    } finally {
      await stopRuntimes();
      await rm(persistence, { recursive: true, force: true });
    }
  },
);

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
    const profiles = await call(runtime, "/discovery/personas?locale=ko");
    expect(profiles.status).toBe(200);
    expect(Schema.decodeUnknownSync(BrowsePage)(await profiles.json()).people).toHaveLength(2);
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
