import { expect, test } from "vitest";
import { serializePersona } from "@ren-ai/personas";
import { importCatalog } from "./catalog-import.ts";
import { readImportSource } from "./import-source.ts";
import { cloudflareFixture } from "../test/cloudflare-fixture.ts";
import { fixture, legacy, portraitImage } from "../test/fixtures.ts";
import { captureWorkerLogs } from "../test/worker-logs.ts";
import type { ImageBucket } from "./r2-images.ts";

async function importFixture() {
  const local = await fixture();
  const imageUrl = await local.store.saveImage(portraitImage);
  await local.store.saveImage(portraitImage);
  await local.store.create({ ...legacy, published: true, imageUrl });
  return { local, source: await readImportSource(local.root), target: await cloudflareFixture() };
}

test("check is read-only; import preserves legacy publication and orphan originals; repeat is idempotent", async () => {
  const { source, target } = await importFixture();
  const { stdout, stderr } = captureWorkerLogs();
  const run = (check: boolean) =>
    importCatalog(target.db, target.bucket, source, check, "test-import");
  expect(await run(true)).toMatchObject({
    check: true,
    personasAdded: 1,
    imagesUploaded: 2,
    missingInitial: [legacy.id],
    incompleteProfiles: [legacy.id],
  });
  expect(await target.store.list()).toEqual([]);
  expect((await target.bucket.list()).objects).toEqual([]);
  expect(await run(false)).toMatchObject({ personasAdded: 1, imagesUploaded: 2 });
  const record = await target.store.get(legacy.id);
  expect(record).toMatchObject({
    id: legacy.id,
    name: legacy.name,
    published: true,
    description: legacy.description,
  });
  expect(await target.store.initial(record.id)).toEqual({ state: "", memory: "" });
  expect((await target.bucket.list()).objects).toHaveLength(2);
  expect(record.imageUrl).toBe(
    `https://persona-images.renai.im/${record.imageUrl.split("/").at(-1)}`,
  );
  expect((await target.store.image(source.images[0]!.key)).status).toBe(200);
  expect(await run(false)).toMatchObject({
    personasAdded: 0,
    imagesUploaded: 0,
    personasUnchanged: 1,
    imagesUnchanged: 2,
  });
  await expect(
    target.store.save(
      record,
      { state: "", memory: "" },
      { persona: serializePersona(record), initial: { state: "", memory: "" } },
    ),
  ).rejects.toMatchObject({ kind: "invalid" });
  await target.store.save(
    { ...record, name: "operator edit", published: false },
    { state: "", memory: "" },
    { persona: serializePersona(record), initial: { state: "", memory: "" } },
  );
  await expect(run(false)).rejects.toThrow("Local Catalog import failed");
  expect((await target.store.get(record.id)).name).toBe("operator edit");
  expect(stderr.mock.calls.map(([line]) => String(line)).join("")).not.toContain(
    legacy.description,
  );
  stdout.mockRestore();
  stderr.mockRestore();
});

test("an existing conflicting R2 key is never overwritten and blocks D1 publication", async () => {
  const { source, target } = await importFixture();
  const { stdout, stderr } = captureWorkerLogs();
  const image = source.images[0]!;
  const changed = new Uint8Array([...portraitImage.bytes, 0]);
  await target.bucket.put(image.key, changed, { httpMetadata: { contentType: image.mimeType } });
  await expect(
    importCatalog(target.db, target.bucket, source, false, "conflict-import"),
  ).rejects.toThrow("Local Catalog import failed");
  expect(await target.store.list()).toEqual([]);
  expect(new Uint8Array(await (await target.bucket.get(image.key))!.arrayBuffer())).toEqual(
    changed,
  );
  stdout.mockRestore();
  stderr.mockRestore();
});

test("a late D1 constraint error rolls back the complete multi-persona import", async () => {
  const { local, source, target } = await importFixture();
  await local.store.create({ ...legacy, id: "blocked", published: false, imageUrl: "" });
  const expanded = await readImportSource(local.root);
  await target.db.exec(
    "CREATE TRIGGER reject_import BEFORE INSERT ON personas WHEN NEW.id = 'legacy' BEGIN SELECT RAISE(ABORT, 'blocked import fixture'); END",
  );
  const { stdout, stderr } = captureWorkerLogs();
  await expect(
    importCatalog(target.db, target.bucket, expanded, false, "atomic-import"),
  ).rejects.toThrow("Local Catalog import failed");
  expect(await target.store.list()).toEqual([]);
  expect((await target.bucket.list()).objects).toHaveLength(source.images.length);
  const logs = stderr.mock.calls.map(([line]) => String(line)).join("");
  expect(logs).not.toContain(legacy.description);
  stdout.mockRestore();
  stderr.mockRestore();
});

test("changed links for an existing Persona conflict instead of resetting photo ordering", async () => {
  const { source, target } = await importFixture();
  const { stdout, stderr } = captureWorkerLogs();
  await importCatalog(target.db, target.bucket, source, false, "first-import");
  await target.db
    .prepare("UPDATE persona_images SET position = 1 WHERE personaId = ?")
    .bind(legacy.id)
    .run();
  await expect(
    importCatalog(target.db, target.bucket, source, false, "second-import"),
  ).rejects.toThrow("Local Catalog import failed");
  stdout.mockRestore();
  stderr.mockRestore();
});

test("independent per-style ordering survives import and repeat", async () => {
  const { local, target } = await importFixture();
  const [anime, photo] = await Promise.all([
    local.store.saveImage(portraitImage),
    local.store.saveImage(portraitImage),
  ]);
  await local.store.update({
    ...(await local.store.get(legacy.id)),
    portraits: { anime, photo },
    imageUrl: photo,
    secondaryPortraits: [{ style: "photo", imageUrl: anime }],
  });
  const source = await readImportSource(local.root);
  const { stdout, stderr } = captureWorkerLogs();
  await importCatalog(target.db, target.bucket, source, false, "ordered-import");
  expect(
    await importCatalog(target.db, target.bucket, source, false, "ordered-repeat"),
  ).toMatchObject({ personasAdded: 0, imagesUploaded: 0 });
  expect((await target.store.get(legacy.id)).secondaryPortraits).toEqual([
    { style: "photo", imageUrl: anime.replace("/images/", "https://persona-images.renai.im/") },
  ]);
  stdout.mockRestore();
  stderr.mockRestore();
});

test.each(["missing", "bytes", "mime"] as const)(
  "a %s upload verification failure blocks all Persona writes",
  async (failure) => {
    const { source, target } = await importFixture();
    const { stdout, stderr } = captureWorkerLogs();
    let uploaded = false;
    const bucket: ImageBucket = {
      get: (key) =>
        failure === "missing" && uploaded ? Promise.resolve(null) : target.bucket.get(key),
      head: (key) => target.bucket.head(key),
      put: async (key, bytes, options) => {
        uploaded = true;
        return target.bucket.put(
          key,
          failure === "bytes" ? new Uint8Array([...bytes, 0]) : bytes,
          failure === "mime" ? { httpMetadata: { contentType: "image/jpeg" } } : options,
        );
      },
    };
    await expect(importCatalog(target.db, bucket, source, false, "broken-upload")).rejects.toThrow(
      "Local Catalog import failed",
    );
    expect(await target.store.list()).toEqual([]);
    stdout.mockRestore();
    stderr.mockRestore();
  },
);

test("verification rejects a successful SQL response that leaves no imported Persona", async () => {
  const local = await fixture();
  await local.store.create({ ...legacy, imageUrl: "" });
  const source = await readImportSource(local.root);
  const target = await cloudflareFixture();
  await target.db.exec(
    "CREATE TRIGGER remove_import AFTER INSERT ON persona_versions BEGIN DELETE FROM personas WHERE id = NEW.personaId; END",
  );
  const { stdout, stderr } = captureWorkerLogs();
  await expect(
    importCatalog(target.db, target.bucket, source, false, "missing-record"),
  ).rejects.toThrow("Local Catalog import failed");
  stdout.mockRestore();
  stderr.mockRestore();
});
