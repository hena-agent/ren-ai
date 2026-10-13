import { expect, test } from "vitest";
import { serializePersona } from "@ren-ai/personas";
import { cloudflareFixture, databasePersona } from "../test/cloudflare-fixture.ts";
import { initialDocuments, portraitImage } from "../test/fixtures.ts";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { personaImages } from "./database-schema.ts";

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

test("R2 previews become public only when referenced by the current published save", async () => {
  const { store } = await cloudflareFixture();
  const imageUrl = await store.saveImage(portraitImage);
  const filename = imageUrl.split("/").at(-1)!;
  expect((await store.image(filename)).status).toBe(200);
  expect((await store.publicImage(filename)).status).toBe(404);
  const record = { ...databasePersona, published: true, imageUrl, portraits: { photo: imageUrl } };
  await store.save(record, initialDocuments, { persona: "" });
  expect((await store.publicImage(filename)).status).toBe(200);
  const profiles = await store.publicList();
  expect(profiles).toHaveLength(1);
  expect(JSON.stringify(profiles)).not.toContain("비공개");
  const saved = await store.get(record.id);
  await store.save({ ...saved, published: false }, initialDocuments, {
    persona: serializePersona(saved),
    initial: initialDocuments,
  });
  expect((await store.publicImage(filename)).status).toBe(404);
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
        imageUrl: "/discovery/images/00000000-0000-0000-0000-000000000000.png",
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
  expect((await store.get(record.id)).gender).toBeUndefined();
});
