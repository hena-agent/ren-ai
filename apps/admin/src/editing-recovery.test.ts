import { expect, test, vi } from "vitest";
import { cloudflareAdmin } from "./cloudflare-admin.ts";
import { editingStorage } from "./editing-storage.ts";
import { cloudflareFixture, adminBindings } from "../test/cloudflare-fixture.ts";
import { memoryStorage } from "../test/memory-storage.ts";
import { captureWorkerLogs } from "../test/worker-logs.ts";
import { character, newToken, request, fixture, legacy, generator } from "../test/fixtures.ts";
import { serializePersona } from "@ren-ai/personas";
import { createImageBatch, restoreImageBatch } from "./image-batch.ts";
import { recoverEditing, downloadEditingRecovery } from "./editing-recovery.ts";
import type { QueueSnapshot } from "./image-queue.ts";

test("an obsolete persisted batch cannot prevent Admin startup, lose its private recovery data or repeat a paid submission", async () => {
  const { db, bucket } = await cloudflareFixture();
  const { storage } = memoryStorage();
  const { stdout, stderr } = captureWorkerLogs();
  const env = adminBindings(db, bucket);
  let admin = await cloudflareAdmin(env, storage);
  const form = {
    ...character,
    draft: await newToken(admin.fetch),
    intent: "generate",
    portraitInstructions: "private recovery prompt",
  };
  await admin.fetch(request("/personas", form));
  const saved = await editingStorage(storage).load();
  const job = saved.queue.jobs[0]!;
  const oldUrl = "/discovery/images/2f8b6431-6c31-4d29-8fd7-fbfc56ce9601.jpg";
  job.batch.source = { ...job.batch.source, imageUrl: oldUrl };
  job.tasks[0]!.state = "completed";
  job.tasks[0]!.imageUrl = oldUrl;
  job.tasks[1]!.state = "generating";
  await storage.put(`job:${job.id}`, job);
  const raw = structuredClone(job);
  admin = await cloudflareAdmin(env, storage);
  const response = await admin.fetch(request("/"));
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("/editing-recovery");
  await admin.alarm();
  expect(admin.fetch.nextJob()).toBeUndefined();
  const unauthenticated = request("/editing-recovery");
  unauthenticated.headers.delete("authorization");
  expect((await admin.fetch(unauthenticated)).status).toBe(401);
  const download = await admin.fetch(request("/editing-recovery"));
  expect(download.status).toBe(200);
  expect(download.headers.get("cache-control")).toBe("no-store");
  expect(await download.text()).toContain(JSON.stringify(raw));
  const active = await editingStorage(storage).load();
  expect(active.queue.jobs).toEqual([]);
  expect(active.queue.pending).toEqual([]);
  expect(active.queue.keys).toEqual(saved.queue.keys);
  expect((await admin.fetch(request("/personas", form))).status).toBe(404);
  admin = await cloudflareAdmin(env, storage);
  expect((await admin.fetch(request("/"))).status).toBe(200);
  const diagnostics = JSON.stringify(stderr.mock.calls);
  expect(diagnostics).toContain("editing_restore_failed");
  expect(diagnostics).toContain("editing.restore");
  expect(diagnostics).toMatch(/requestId/);
  expect(diagnostics).not.toContain("private recovery prompt");
  expect(diagnostics).not.toContain(character.description);
  stdout.mockRestore();
  stderr.mockRestore();
  vi.restoreAllMocks();
});

test("invalid drafts isolate only their persona and repeated recovery never overwrites an earlier archive", async () => {
  const { store } = await fixture();
  const { storage } = memoryStorage();
  const { stdout, stderr } = captureWorkerLogs();
  const jobOf = (id: string): QueueSnapshot["jobs"][number] => {
    const record = { ...legacy, id };
    const draft = {
      id,
      base: serializePersona(record),
      preview: serializePersona(record),
      imageCount: 1,
    };
    return {
      id,
      state: "queued",
      queuedAt: 1,
      requestId: "original-request",
      tasks: [],
      batch: createImageBatch(
        record,
        draft,
        "generate",
        new URLSearchParams(),
        "",
        generator,
        store,
      ).snapshot(),
    };
  };
  const broken = jobOf("broken");
  const healthy = jobOf("healthy");
  const draft = { ...broken.batch.latest, preview: "private invalid draft" };
  const saved = {
    drafts: [
      ["broken", draft],
      ["healthy", healthy.batch.latest],
    ] as const,
    queue: {
      jobs: [broken, healthy],
      pending: ["broken", "healthy", "missing"],
      keys: [["receipt", "broken"]] as const,
    },
  };
  const restore = (batch: Parameters<typeof restoreImageBatch>[0]) =>
    restoreImageBatch(batch, generator, store);
  const result = await recoverEditing(storage, saved, restore);
  expect(result.drafts).toEqual([["healthy", healthy.batch.latest]]);
  expect(result.queue).toEqual({ jobs: [healthy], pending: ["healthy"], keys: saved.queue.keys });
  const first = await (await downloadEditingRecovery(storage)).text();
  await recoverEditing(storage, saved, restore);
  const second = await (await downloadEditingRecovery(storage)).text();
  expect(first.match(/recovery:/g)).toHaveLength(2);
  expect(second.match(/recovery:/g)).toHaveLength(4);
  expect(second).toContain("private invalid draft");
  expect(JSON.stringify(stderr.mock.calls)).not.toContain("private invalid draft");
  stdout.mockRestore();
  stderr.mockRestore();
});
