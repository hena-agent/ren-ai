import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { discoveryNotice } from "@ren-ai/onboarding";
import { expect, test } from "vitest";
import { contactEntries, stopRuntimes, trackRuntime } from "../test/cloudflare-test-fixture.ts";
import { readStateSnapshot } from "./state-snapshot.ts";
import { readyApplicationHealth } from "../test/execution-bindings.ts";

let bundledWorker: Promise<string> | undefined;
const workerSource = () => {
  bundledWorker ??= build({
    entryPoints: [new URL("../test/cloudflare-worker-entry.ts", import.meta.url).pathname],
    loader: { ".md": "text" },
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker"],
    mainFields: ["module", "main"],
    target: "es2023",
    external: ["cloudflare:workers", "node:*"],
    write: false,
  }).then((result) => result.outputFiles[0]!.text);
  return bundledWorker;
};

const textBinding = (value: string) => ({ type: "text" as const, value });
const openWorker = async (
  resourcePersistencePath: string,
  bootstrapOnly: boolean,
  secrets = true,
) => {
  const source = await workerSource();
  const runtime = new Miniflare({
    resourcePersistencePath,
    workers: [
      {
        config: {
          name: "api-app-worker-test",
          compatibilityDate: "2026-10-13",
          compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
          exports: { ApiApplication: { type: "durable-object", storage: "sqlite" } },
          manifest: {
            mainModule: "index.js",
            modules: { "index.js": { type: "esm", contents: source } },
          },
          env: {
            APPLICATION: {
              type: "durable-object",
              worker: "api-app-worker-test",
              exportName: "ApiApplication",
            },
            PERSONA_CATALOG_URL: textBinding("https://admin.example"),
            ...(secrets && {
              TOKEN_CATALOG: textBinding("catalog-secret"),
              TURNSTILE_SECRET: textBinding("turnstile-secret"),
              TOKEN_MANAGEMENT: textBinding("management-secret"),
            }),
            API_MSG_URL: textBinding("https://api-msg.example"),
            BOOTSTRAP_ONLY: textBinding(String(bootstrapOnly)),
          },
        },
      },
    ],
  });
  return trackRuntime(runtime);
};

const send = (runtime: Miniflare, path: string, init?: Parameters<Miniflare["dispatchFetch"]>[1]) =>
  runtime.dispatchFetch(`https://api-app.example${path}`, init);

test("public reads work without private secrets while management and registration fail closed", async () => {
  const persistence = await mkdtemp(join(tmpdir(), "api-app-public-"));
  try {
    const runtime = await openWorker(persistence, false, false);
    const health = await send(runtime, "/health");
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({
      service: "api-app",
      status: "degraded",
      database: "ready",
      executor: { status: "unconfigured" },
    });
    const profiles = await send(runtime, "/discovery/personas");
    expect(profiles.status).toBe(200);
    expect(await profiles.json()).toMatchObject([{ id: "sora" }]);
    expect(
      (
        await send(runtime, "/management/discovery", {
          headers: { Authorization: "Bearer " },
        })
      ).status,
    ).toBe(401);
    const registration = await send(runtime, "/discovery/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        handle: "+821012345678",
        locale: "ko",
        likedPersonaIDs: ["sora"],
        privacyNoticeVersion: discoveryNotice.version,
        turnstileToken: "human",
      }),
    });
    expect(registration.status).toBe(400);
    expect(await registration.json()).toBe("verification");
  } finally {
    await stopRuntimes();
    await rm(persistence, { recursive: true, force: true });
  }
});

test("compiled Worker serves safely in bootstrap and activates persisted registry after cutover", async () => {
  const persistence = await mkdtemp(join(tmpdir(), "api-app-worker-"));
  try {
    let runtime = await openWorker(persistence, true);
    const health = await send(runtime, "/health");
    expect(await health.json()).toEqual(readyApplicationHealth);
    expect((await send(runtime, "/discovery/personas")).status).toBe(200);
    expect(
      (
        await send(runtime, "/discovery/waitlist", {
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await send(runtime, "/management/discovery", {
          headers: { Authorization: "Bearer management-secret" },
        })
      ).status,
    ).toBe(200);

    await stopRuntimes();
    runtime = await openWorker(persistence, false);
    const registration = await send(runtime, "/discovery/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
      body: JSON.stringify({
        handle: "+821012345678",
        locale: "ko",
        privacyNoticeVersion: discoveryNotice.version,
        turnstileToken: "human",
        likedPersonaIDs: ["sora"],
      }),
    });
    expect(registration.status).toBe(200);
    expect(await registration.json()).toEqual({ status: "waiting" });

    const list = await send(runtime, "/management/discovery", {
      headers: { Authorization: "Bearer management-secret" },
    });
    const waiting = await contactEntries(() => list.text());
    expect(waiting.entries).toHaveLength(1);
    const selection = {
      requestId: "00000000-0000-4000-8000-000000000019",
      count: 1,
    };
    const select = () =>
      send(runtime, "/management/discovery/select", {
        method: "POST",
        headers: {
          Authorization: "Bearer management-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(selection),
      });
    const selected = await select();
    expect(selected.status).toBe(200);
    expect(await (await select()).json()).toEqual(await selected.json());

    await stopRuntimes();
    runtime = await openWorker(persistence, false);
    const restored = await send(runtime, "/management/discovery", {
      headers: { Authorization: "Bearer management-secret" },
    });
    const restoredContacts = await contactEntries(() => restored.text());
    expect(restoredContacts.entries[0]?.handle).toBe("+821012345678");
    expect(restoredContacts.entries[0]?.id).toBe(waiting.entries[0]?.id);
  } finally {
    await stopRuntimes();
    await rm(persistence, { recursive: true, force: true });
  }
});

test("compiled SQLite DO imports linked private state atomically and recognizes a repeated archive", async () => {
  const persistence = await mkdtemp(join(tmpdir(), "api-app-state-transfer-"));
  try {
    const runtime = await openWorker(persistence, true);
    const headers = {
      Authorization: "Bearer management-secret",
      "Content-Type": "application/json",
    };
    const exported = await send(runtime, "/management/state/export", { headers });
    expect(exported.status).toBe(200);
    const empty = readStateSnapshot(await exported.json());
    const user: Record<string, string | number | null> = {
      id: 7,
      handle: "source-marker@example.test",
      locale: "ko",
      consent_version: "v1",
      consent_language: "ko",
      consent_at: 1,
      joined_at: 2,
      replied_at: null,
      persona_id: "sora",
    };
    const conversation: Record<string, string | number | null> = {
      id: 9,
      user_id: 7,
      persona_id: "sora",
      session_id: "ses_preserved",
      started_at: 3,
      rebuilding: 0,
      last_received_at: 4,
      reset_guid: null,
    };
    const snapshot = {
      ...empty,
      tables: empty.tables.map((table) => ({
        ...table,
        rows:
          table.name === "user"
            ? [table.columns.map((column) => user[column] ?? null)]
            : table.name === "conversation"
              ? [table.columns.map((column) => conversation[column] ?? null)]
              : table.rows,
      })),
    };
    const imported = await send(runtime, "/management/state/import", {
      method: "POST",
      headers,
      body: JSON.stringify(snapshot),
    });
    expect(imported.status).toBe(200);
    expect(await imported.text()).not.toContain("source-marker@example.test");
    const repeated = await send(runtime, "/management/state/import", {
      method: "POST",
      headers,
      body: JSON.stringify(snapshot),
    });
    expect(await repeated.json()).toMatchObject({ repeated: true });
    const restored = readStateSnapshot(
      await (await send(runtime, "/management/state/export", { headers })).json(),
    );
    expect(restored.tables.find((table) => table.name === "conversation")?.rows[0]).toContain(
      "ses_preserved",
    );
    expect((await send(runtime, "/management/state/export")).status).toBe(401);
  } finally {
    await stopRuntimes();
    await rm(persistence, { recursive: true, force: true });
  }
});
