import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoveryNotice } from "@ren-ai/onboarding";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { expect, test } from "vitest";
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
const register = (runtime: Miniflare, handle: string) =>
  call(runtime, "/discovery/waitlist", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": handle },
    body: JSON.stringify({
      handle,
      locale: "ko",
      privacyNoticeVersion: discoveryNotice.version,
      turnstileToken: "human",
      likedPersonaIDs: ["sora", "luna"],
    }),
  });

test("registry persists state on the Durable Object across recreation", async () => {
  const persistence = await mkdtemp(join(tmpdir(), "api-app-store-"));
  try {
    let runtime = await openRuntime(persistence);
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
    expect((await select({ ...selection, count: 2 })).status).toBe(503);
    expect((await call(runtime, "/discovery/unknown")).status).toBe(404);
    expect((await call(runtime, "/discovery/images/test.jpg")).status).toBe(404);
    expect((await call(runtime, "/unknown")).status).toBe(404);

    const state = await call(runtime, "/__fixture/state");
    expect(await state.json()).toEqual({
      registrations: [
        { id: registrationID, handle: "+821012345678" },
        { id: otherRegistrationID, handle: "+821087654321" },
      ].toSorted((left, right) => left.handle.localeCompare(right.handle)),
      selections: [
        { requestId: "00000000-0000-4000-8000-000000000001" },
        { requestId: "00000000-0000-4000-8000-000000000002" },
      ],
      assignments: [
        { personaID: "luna", handle: "+821087654321" },
        { personaID: "sora", handle: "+821012345678" },
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
    expect(
      (
        await call(runtime, "/__fixture/reopen-conflict", {
          method: "POST",
        })
      ).status,
    ).toBe(200);
    const failedStartup = await call(runtime, "/management/discovery", {
      headers: { Authorization: "Bearer management-test" },
    });
    expect(failedStartup.status).toBe(500);
  } finally {
    await stopRuntimes();
    await rm(persistence, { recursive: true, force: true });
  }
});
