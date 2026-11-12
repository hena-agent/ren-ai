import { expect, test } from "vitest";
import { fixture, portraitImage } from "../test/fixtures.ts";
import { cloudflareFixture } from "../test/cloudflare-fixture.ts";
import { storedLayers } from "../test/artwork-layers.ts";

test.each(["file", "D1"])(
  "%s layer manifests are atomically tied to the current artwork and recover their receipt",
  async (target) => {
    const { store } = target === "file" ? await fixture() : await cloudflareFixture();
    const image = {
      model: "fal:source",
      imageUrl: await store.saveImage(portraitImage),
      operationId: "art-source",
    };
    await store.saveRigArtwork("layers-persona", image);
    const layers = storedLayers(image.imageUrl);
    await store.saveRigArtworkLayers("layers-persona", layers);
    expect((await store.rigArtwork("layers-persona"))!.layers).toEqual(layers);
    await expect(store.saveRigArtworkLayers("layers-persona", layers)).rejects.toMatchObject({
      kind: "conflict",
    });
    await expect(store.saveRigArtworkLayers("missing-persona", layers)).rejects.toMatchObject({
      kind: "conflict",
    });
    await expect(
      store.saveRigArtworkLayers(
        "layers-persona",
        { ...layers, sourceOperationId: "other" },
        layers.operationId,
      ),
    ).rejects.toMatchObject({ kind: "conflict" });
    await store.saveRigArtworkLayers(
      "layers-persona",
      { ...layers, operationId: "new-layers" },
      layers.operationId,
    );
    expect((await store.rigArtwork("layers-persona"))!.imageUrl).toBe(image.imageUrl);
    const invalid = {
      ...layers,
      layers: layers.layers.map((layer) => ({
        ...layer,
        imageUrl: "https://evil.example/private.png",
      })),
    };
    await expect(
      store.saveRigArtworkLayers("layers-persona", invalid, "new-layers"),
    ).rejects.toMatchObject({ kind: "invalid" });
    await expect(
      store.saveRigArtwork("layers-persona", { ...image, layers: invalid }, image.operationId),
    ).rejects.toMatchObject({ kind: "invalid" });
    await store.saveRigArtwork(
      "layers-persona",
      { ...image, layers: { ...layers, operationId: "new-layers" } },
      image.operationId,
    );
    await store.saveRigArtwork(
      "layers-persona",
      { ...image, operationId: "next-source" },
      image.operationId,
    );
    expect((await store.rigArtwork("layers-persona"))!.layers).toBeUndefined();
  },
);

test("layer compare-and-swap queries use the artwork primary key rather than scanning history", async () => {
  const { db } = await cloudflareFixture();
  const plan = await db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT layers_json FROM persona_rig_artworks WHERE personaId = ? AND operationId = ? AND json_extract(layers_json, '$.operationId') = ?",
    )
    .bind("id", "source", "layers")
    .all();
  expect(JSON.stringify(plan.results)).toMatch(/SEARCH.*persona_rig_artworks.*INDEX/);
});
