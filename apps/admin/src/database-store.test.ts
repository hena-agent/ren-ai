import { expect, test } from "vitest";
import { serializePersona } from "@ren-ai/personas";
import { cloudflareFixture, databasePersona } from "../test/cloudflare-fixture.ts";
import { initialDocuments, portraitImage } from "../test/fixtures.ts";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { personaImages, personaVersions, personas } from "./database-schema.ts";

test("an empty D1 Catalog accepts an atomic document save and rejects stale snapshots", async () => {
  const { store } = await cloudflareFixture();
  expect(await store.list()).toEqual([]);
  expect(await store.publicList()).toEqual([]);
  expect(await store.catalog()).toEqual({ revision: "[]", personas: [] });
  await expect(store.get("missing")).rejects.toMatchObject({ kind: "not_found" });
  await expect(store.importDraft("old")).rejects.toMatchObject({ kind: "not_found" });
  await store.save(databasePersona, initialDocuments, { persona: "" });
  const saved = await store.get(databasePersona.id);
  expect(saved.description).toBe(databasePersona.description);
  expect(await store.initial(saved.id)).toEqual(initialDocuments);
  expect(await store.source(saved.id)).toBe(serializePersona(saved));
  expect(await store.inspect()).toEqual([{ id: saved.id, persona: saved }]);
  const expected = { persona: serializePersona(saved), initial: initialDocuments };
  const changed = { ...saved, name: "new name" };
  const results = await Promise.allSettled([
    store.save(changed, initialDocuments, expected),
    store.save({ ...saved, language: "en" }, initialDocuments, expected),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  await expect(store.save(changed, initialDocuments, expected)).rejects.toMatchObject({
    kind: "conflict",
  });
  await expect(
    store.save(saved, { ...initialDocuments, memory: "changed" }, { persona: "" }),
  ).rejects.toMatchObject({ kind: "conflict" });
});

test("private Admin listing retains unpublished documents, version metadata and each persona's own photos", async () => {
  const { store } = await cloudflareFixture();
  await store.save({ ...databasePersona, descriptionVersion: 1 }, initialDocuments, {
    persona: "",
  });
  const imageUrl = await store.saveImage(portraitImage);
  await store.save(
    { ...databasePersona, id: "with-photo", imageUrl, portraits: { photo: imageUrl } },
    initialDocuments,
    { persona: "" },
  );
  const records = await store.list();
  expect(records.map((record) => record.id)).toEqual([databasePersona.id, "with-photo"]);
  expect(records[0]).toMatchObject({
    descriptionVersion: 1,
    imageUrl: "",
    description: databasePersona.description,
  });
  expect(records[0]).not.toHaveProperty("portraits");
  expect(records[1]!.portraits).toEqual({ photo: imageUrl });
  expect(await store.publicList()).toEqual([]);
});

test("Catalog publication controls listing, while images retain their direct R2 URLs", async () => {
  const { store } = await cloudflareFixture();
  const imageUrl = await store.saveImage(portraitImage);
  const filename = imageUrl.split("/").at(-1)!;
  expect((await store.image(filename)).status).toBe(200);
  expect(imageUrl).toBe(`https://persona-images.renai.im/${filename}`);
  const record = { ...databasePersona, published: true, imageUrl, portraits: { photo: imageUrl } };
  await store.save(record, initialDocuments, { persona: "" });
  const profiles = await store.publicList();
  expect(profiles).toHaveLength(1);
  expect(profiles[0]!.imageUrl).toBe(imageUrl);
  expect(JSON.stringify(profiles)).not.toContain("비공개");
  const saved = await store.get(record.id);
  await store.save({ ...saved, published: false }, initialDocuments, {
    persona: serializePersona(saved),
    initial: initialDocuments,
  });
  expect(await store.publicList()).toEqual([]);
  expect((await store.image(filename)).status).toBe(200);
});

test("publication and owned-image validation fail before a document commit", async () => {
  const { store } = await cloudflareFixture();
  await expect(
    store.save({ ...databasePersona, published: true }, initialDocuments, { persona: "" }),
  ).rejects.toMatchObject({ kind: "invalid" });
  await expect(
    store.save(
      { ...databasePersona, imageUrl: "https://example.net/photo.png" },
      initialDocuments,
      { persona: "" },
    ),
  ).rejects.toMatchObject({ kind: "invalid" });
  await expect(
    store.save(
      {
        ...databasePersona,
        imageUrl: "https://persona-images.renai.im/00000000-0000-0000-0000-000000000000.png",
      },
      initialDocuments,
      { persona: "" },
    ),
  ).rejects.toMatchObject({ kind: "invalid" });
  expect(await store.list()).toEqual([]);
});

test("the relational schema enforces photo ownership and supports records whose gender is derived from Markdown", async () => {
  const { db, store } = await cloudflareFixture();
  const config = getTableConfig(personaImages);
  const versionShape = getTableConfig(personaVersions);
  expect(versionShape.primaryKeys.map((key) => key.columns.map((column) => column.name))).toEqual([
    ["personaId", "version"],
  ]);
  expect(versionShape.foreignKeys[0]!.reference().foreignTable).toBe(personas);
  expect(config.indexes.map((index) => index.config.unique)).toEqual([true]);
  expect(config.foreignKeys[0]!.reference().foreignColumns.map((column) => column.name)).toEqual([
    "id",
  ]);
  await expect(
    db
      .prepare("INSERT INTO persona_images VALUES ('missing', 'image', 'photo', 0, 'image/png', 8)")
      .run(),
  ).rejects.toThrow("FOREIGN KEY");
  const record = { ...databasePersona };
  delete record.gender;
  await store.save(record, initialDocuments, { persona: "" });
  await expect(
    db
      .prepare("INSERT INTO persona_versions VALUES (?, 1, 'must not overwrite', 1, NULL)")
      .bind(record.id)
      .run(),
  ).rejects.toThrow("UNIQUE");
  expect((await store.version(record.id, 1)).markdown).toBe(record.description);
  expect((await store.get(record.id)).gender).toBeUndefined();
});
