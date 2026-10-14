import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { discoveryNotice } from "@ren-ai/onboarding";
import { expect, test } from "vitest";
import { contactEntries, stopRuntimes, trackRuntime } from "../test/cloudflare-test-fixture.ts";

let bundledWorker: Promise<string> | undefined;
const workerSource = () => {
  bundledWorker ??= build({
    entryPoints: [new URL("../test/cloudflare-worker-entry.ts", import.meta.url).pathname],
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
const openWorker = async (resourcePersistencePath: string, bootstrapOnly: boolean) => {
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
            TOKEN_CATALOG: textBinding("catalog-secret"),
            TURNSTILE_SECRET: textBinding("turnstile-secret"),
            TOKEN_MANAGEMENT: textBinding("management-secret"),
            API_MSG_URL: textBinding("https://api-msg.example"),
            TOKEN_EXECUTOR: textBinding("executor-secret"),
            REN_AI_APPLICATION_TOKEN: textBinding("application-secret"),
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

test("compiled Worker serves safely in bootstrap and activates persisted registry after cutover", async () => {
  const persistence = await mkdtemp(join(tmpdir(), "api-app-worker-"));
  try {
    let runtime = await openWorker(persistence, true);
    const health = await send(runtime, "/health");
    expect(await health.json()).toEqual({
      database: "ready",
      storage: "durable-object-sqlite",
      bootstrapOnly: true,
    });
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
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "person@example.com" },
      body: JSON.stringify({
        handle: "person@example.com",
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
    expect(restoredContacts.entries[0]?.handle).toBe("person@example.com");
    expect(restoredContacts.entries[0]?.id).toBe(waiting.entries[0]?.id);
  } finally {
    await stopRuntimes();
    await rm(persistence, { recursive: true, force: true });
  }
});
