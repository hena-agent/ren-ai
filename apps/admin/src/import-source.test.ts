import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readImportSource, importImageBytes } from "./import-source.ts";
import { databasePersona } from "../test/cloudflare-fixture.ts";
import { fixture, initialDocuments, legacy, portraitImage } from "../test/fixtures.ts";

test("the scanner captures current initial documents and verifies every referenced image", async () => {
  const { root, store } = await fixture();
  const imageUrl = await store.saveImage(portraitImage);
  await store.save({ ...databasePersona, published: true, imageUrl }, initialDocuments, {
    persona: "",
  });
  const source = await readImportSource(root);
  expect(source.personas[0]).toMatchObject({
    missingInitial: false,
    incompleteProfile: false,
    documents: initialDocuments,
  });
  expect(await importImageBytes(source.images[0]!)).toEqual(portraitImage.bytes);
  await writeFile(source.images[0]!.file, new Uint8Array([...portraitImage.bytes, 0]));
  await expect(importImageBytes(source.images[0]!)).rejects.toThrow("changed after inspection");
  await expect(importImageBytes({ ...source.images[0]!, file: root })).rejects.toThrow(
    "not a regular file",
  );
});

test("no-image drafts work, while malformed, missing and inconsistent saved data fail preflight", async () => {
  const { root, store } = await fixture();
  await expect(readImportSource(root)).rejects.toThrow("Saved Catalog input is invalid");
  await store.create({ ...legacy, imageUrl: "" });
  expect((await readImportSource(root)).images).toEqual([]);
  await mkdir(join(root, "images"));
  await writeFile(join(root, "images", "bad.png"), portraitImage.bytes);
  await expect(readImportSource(root)).rejects.toThrow("Saved Catalog input is invalid");
  await rm(join(root, "images"), { recursive: true });
  await writeFile(join(root, "images"), "not a directory");
  await expect(readImportSource(root)).rejects.toThrow("Saved Catalog input is invalid");
  await rm(join(root, "images"));
  const imageUrl = await store.saveImage(portraitImage);
  await store.update({ ...legacy, imageUrl, portraits: { anime: imageUrl } });
  await rm(join(root, "images", imageUrl.split("/").at(-1)!));
  await expect(readImportSource(root)).rejects.toThrow("Saved Catalog input is invalid");
});

test("supported JPEG/WebP originals scan without regeneration and inconsistent main references fail", async () => {
  const { root, store } = await fixture();
  const jpeg = await store.saveImage({
    bytes: Buffer.from("ffd8ff00", "hex"),
    mimeType: "image/jpeg",
  });
  const webp = await store.saveImage({
    bytes: Buffer.from("524946460000000057454250", "hex"),
    mimeType: "image/webp",
  });
  await store.create({ ...legacy, imageUrl: jpeg, portraits: { anime: webp, photo: jpeg } });
  expect((await readImportSource(root)).images.map((image) => image.mimeType).toSorted()).toEqual([
    "image/jpeg",
    "image/webp",
  ]);
  await store.update({ ...(await store.get(legacy.id)), imageUrl: webp });
  await expect(readImportSource(root)).rejects.toThrow("Saved Catalog input is invalid");
});
