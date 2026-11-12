import { expect, test } from "vitest";
import { fixture, portraitImage } from "../test/fixtures.ts";
import { cloudflareFixture } from "../test/cloudflare-fixture.ts";
import { storedLayers } from "../test/artwork-layers.ts";

test.each(["files", "D1"])(
  "%s stores body and outfit independently and fences source, result and replacements",
  async (backend) => {
    const { store } = backend === "files" ? await fixture() : await cloudflareFixture();
    const imageUrl = await store.saveImage(portraitImage);
    const body = { model: "fal:test", imageUrl, operationId: "body", kind: "body" as const };
    const outfit = {
      model: "fal:clothes",
      imageUrl,
      operationId: "outfit",
      sourceOperationId: body.operationId,
    };
    await expect(store.saveRigArtworkOutfit("target", outfit)).rejects.toMatchObject({
      kind: "conflict",
    });
    await store.saveRigArtwork("target", body);
    await expect(store.saveRigArtwork("other", { ...body, outfit })).rejects.toMatchObject({
      kind: "invalid",
    });
    await expect(
      store.saveRigArtworkOutfit("target", { ...outfit, imageUrl: "https://outside.test/x.png" }),
    ).rejects.toMatchObject({ kind: "invalid" });
    await store.saveRigArtworkOutfit("target", {
      ...outfit,
      layers: storedLayers(imageUrl, "outfit"),
    });
    await expect(store.saveRigArtworkOutfit("target", outfit)).rejects.toMatchObject({
      kind: "conflict",
    });
    await expect(
      store.saveRigArtworkOutfit("target", { ...outfit, sourceOperationId: "old-body" }, "outfit"),
    ).rejects.toMatchObject({ kind: "conflict" });
    await expect(
      store.saveRigArtworkLayers("target", storedLayers(imageUrl, "outfit"), undefined, "outfit"),
    ).rejects.toMatchObject({ kind: "conflict" });
    const layers = storedLayers(imageUrl, "outfit", "outfit-parts");
    await store.saveRigArtworkLayers("target", layers, "layer-result", "outfit");
    expect((await store.rigArtwork("target"))!.outfit!.layers).toEqual(layers);
    const next = { ...outfit, operationId: "new-outfit" };
    await store.saveRigArtworkOutfit("target", next, outfit.operationId);
    await store.saveRigArtworkLayers(
      "target",
      storedLayers(imageUrl, "new-outfit"),
      undefined,
      "outfit",
    );
    await store.saveRigArtworkLayers("target", storedLayers(imageUrl, "body"));
    const current = (await store.rigArtwork("target"))!;
    expect(current.kind).toBe("body");
    expect(current.outfit!.operationId).toBe("new-outfit");
    expect(current.layers!.sourceOperationId).toBe("body");
    await store.saveRigArtwork("target", { ...body, operationId: "new-body" }, "body");
    expect((await store.rigArtwork("target"))!.outfit).toBeUndefined();
    await expect(
      store.saveRigArtworkLayers("target", layers, undefined, "outfit"),
    ).rejects.toMatchObject({ kind: "conflict" });
  },
);
