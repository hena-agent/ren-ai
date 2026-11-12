import { expect, test } from "vitest";
import { cloudflareFixture, databasePersona } from "../test/cloudflare-fixture.ts";
import { initialDocuments, portraitImage } from "../test/fixtures.ts";
import { databaseStore } from "./database-store.ts";
import { storedLayers } from "../test/artwork-layers.ts";

test("D1 keeps one artwork row per persona, rejects stale replacements and never projects source artwork into Catalog", async () => {
  const { store, db, bucket } = await cloudflareFixture();
  const imageUrl = await store.saveImage(portraitImage);
  const original = { model: "seedream-5-lite" as const, imageUrl, operationId: "first" };
  expect(await store.rigArtwork("harin")).toBeUndefined();
  await store.saveRigArtwork("harin", original);
  const other = { ...original, operationId: "other" };
  await store.saveRigArtwork("other", other);
  await expect(store.saveRigArtwork("harin", other)).rejects.toMatchObject({ kind: "conflict" });
  await expect(store.saveRigArtwork("harin", other, "stale")).rejects.toMatchObject({
    kind: "conflict",
  });
  const replacement = {
    ...original,
    model: "flux-2-klein-9b" as const,
    operationId: "second",
    imageUrl: await store.saveImage(portraitImage),
  };
  await store.saveRigArtwork("harin", replacement, original.operationId);
  const restored = databaseStore(db, bucket);
  expect(await restored.rigArtwork("harin")).toEqual(replacement);
  expect(await restored.rigArtwork("other")).toEqual(other);
  await restored.save(databasePersona, initialDocuments, { persona: "" });
  expect(JSON.stringify(await restored.catalog())).not.toContain(replacement.imageUrl);
  expect(JSON.stringify(await restored.get("harin"))).not.toContain("rigArtwork");
  const count = await db
    .prepare("SELECT COUNT(*) AS count FROM persona_rig_artworks WHERE personaId = ?")
    .bind("harin")
    .first<number>("count");
  expect(count).toBe(1);
});

test("face parts and hair planes survive D1 reopening, stay private, and reject external textures", async () => {
  const { store, db, bucket } = await cloudflareFixture();
  const imageUrl = await store.saveImage(portraitImage);
  await store.saveRigArtwork("harin", { model: "test", imageUrl, operationId: "art-source" });
  const layers = {
    ...storedLayers(imageUrl),
    faceParts: [{ role: "mouth" as const, state: "neutral" as const, imageUrl }],
    layers: storedLayers(imageUrl).layers.map((layer) => ({
      ...layer,
      plane: "front-body" as const,
    })),
  };
  await store.saveRigArtworkLayers("harin", layers);
  expect((await databaseStore(db, bucket).rigArtwork("harin"))!.layers).toEqual(layers);
  await expect(
    store.saveRigArtworkLayers(
      "harin",
      {
        ...layers,
        faceParts: [{ ...layers.faceParts[0]!, imageUrl: "https://outside.example/private.png" }],
      },
      layers.operationId,
    ),
  ).rejects.toMatchObject({ kind: "invalid" });
  expect((await store.rigArtwork("harin"))!.layers).toEqual(layers);
});
