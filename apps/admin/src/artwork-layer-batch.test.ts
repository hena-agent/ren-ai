import { expect, test } from "vitest";
import { serializePersona } from "@ren-ai/personas";
import { fixture, generator, portraitImage, character } from "../test/fixtures.ts";
import { layerService, layerFetch, layerResponse, storedLayers } from "../test/artwork-layers.ts";
import { fetchUrl } from "../test/fetch-url.ts";
import { emptyPersona } from "./authoring.ts";
import { artworkLayerBatch } from "./artwork-layer-batch.ts";
import { createImageBatch, restoreImageBatch, type ImageBatchSnapshot } from "./image-batch.ts";
import { artworkLayerModel } from "./artwork-layer-model.ts";

async function prepared() {
  const { store } = await fixture();
  const { service, fetcher } = layerService();
  const source = {
    ...emptyPersona,
    ...character,
    prompt: character.description,
    id: "layer-persona",
  };
  const image = {
    model: "fal:original",
    imageUrl: await store.saveImage(portraitImage),
    operationId: "art-source",
  };
  await store.saveRigArtwork(source.id, image);
  const { selection } = await service.options(image.operationId);
  const original = {
    id: source.id,
    base: "",
    preview: serializePersona(source),
    rigArtwork: { model: image.model, image, layerize: selection },
  };
  const snapshot: ImageBatchSnapshot = {
    operationId: "layer-task",
    source,
    original,
    current: source,
    latest: original,
    intent: "rig-layers",
    params: "",
    key: "rig-layers",
    prompts: ["private layer direction"],
    expectedBase: "",
  };
  const paid = () =>
    fetcher.mock.calls.filter(
      ([input, init]) =>
        fetchUrl(input).startsWith("https://queue.fal.run/") && init?.method === "POST",
    ).length;
  return { store, service, fetcher, snapshot, image, paid };
}

function providerOutput(f: Awaited<ReturnType<typeof prepared>>, output: object) {
  f.fetcher.mockImplementation(async (input, init) =>
    fetchUrl(input).includes("/requests/") && !fetchUrl(input).endsWith("/status")
      ? Response.json(output)
      : layerFetch(input, init),
  );
}

test("layer saving resumes after actor replacement without repeating the paid call or completed PNGs", async () => {
  const f = await prepared();
  let failed = false;
  f.fetcher.mockImplementation(async (input, init) => {
    if (fetchUrl(input).endsWith("/arm.png") && !failed) {
      failed = true;
      return new Response(null, { status: 503 });
    }
    return layerFetch(input, init);
  });
  const batch = artworkLayerBatch(f.snapshot, f.service, f.store);
  await batch.prepare();
  batch.setPrompt(0, "private revised direction");
  await expect(batch.run(0, async () => {})).rejects.toThrow("download failed");
  expect(batch.finish(true).rigArtwork!.image).toEqual(f.image);
  const saved = batch.snapshot();
  expect(saved.layerize!.saved).toHaveLength(1);
  expect(f.paid()).toBe(1);
  expect(() => batch.setPrompt(0, "changed after payment")).toThrow("원래 지시");
  const restored = restoreImageBatch(saved, { ...generator, layerize: f.service }, f.store);
  restored.resume(saved.latest, [0]);
  restored.setPrompt(0, "private revised direction");
  await restored.prepare();
  expect(await restored.run(0, async () => {})).toBe(f.image.imageUrl);
  const completed = restored.finish(false);
  expect(completed.rigArtwork!.image!.layers!.layers).toHaveLength(2);
  expect(completed.rigArtwork!.image!.layers!.layers[0]!.imageUrl).toBe(
    saved.layerize!.saved[0]!.imageUrl,
  );
  expect(restored.snapshot().layerize).toBeUndefined();
  expect(f.paid()).toBe(1);
  const recovered = artworkLayerBatch(f.snapshot, f.service, f.store);
  await recovered.prepare();
  expect(await recovered.run(0, async () => {})).toBe(f.image.imageUrl);
  expect(recovered.record()).toEqual(f.snapshot.source);
  expect(f.paid()).toBe(1);
  const previous = (await f.store.rigArtwork(f.snapshot.source.id))!.layers!;
  await f.store.saveRigArtworkLayers(
    f.snapshot.source.id,
    { ...previous, operationId: "layout-edit", generationOperationId: previous.operationId },
    previous.operationId,
  );
  const adjusted = artworkLayerBatch(f.snapshot, f.service, f.store);
  await adjusted.prepare();
  await adjusted.run(0, async () => {});
  expect(adjusted.draft().rigArtwork!.image!.layers!.operationId).toBe("layout-edit");
  expect(f.paid()).toBe(1);
});

test("source and layer CAS changes block stale work before charging", async () => {
  const f = await prepared();
  const batch = artworkLayerBatch(f.snapshot, f.service, f.store);
  const layers = storedLayers(f.image.imageUrl);
  await f.store.saveRigArtworkLayers(f.snapshot.source.id, layers);
  await expect(batch.prepare()).rejects.toMatchObject({ kind: "conflict" });
  await f.store.saveRigArtwork(
    f.snapshot.source.id,
    { ...f.image, operationId: "new-source" },
    f.image.operationId,
  );
  await expect(batch.run(0, async () => {})).rejects.toMatchObject({ kind: "conflict" });
  expect(f.paid()).toBe(0);
});

test("an acknowledged fal queue receipt survives a result-fetch failure without a second submission", async () => {
  const f = await prepared();
  let fail = true;
  f.fetcher.mockImplementation(async (input, init) => {
    if (fetchUrl(input).endsWith("/status") && fail) {
      fail = false;
      throw new Error("result fetch disconnected");
    }
    return layerFetch(input, init);
  });
  const batch = artworkLayerBatch(f.snapshot, f.service, f.store);
  await expect(batch.run(0, async () => {})).rejects.toMatchObject({
    fields: { code: "network_error" },
  });
  const saved = batch.snapshot();
  expect(saved.layerize!.requestId).toBe("test-layer-request");
  expect(saved.layerize!.response).toBeUndefined();
  const restored = restoreImageBatch(saved, { ...generator, layerize: f.service }, f.store);
  await restored.prepare();
  await restored.run(0, async () => {});
  expect(f.paid()).toBe(1);
  expect(restored.finish(false).rigArtwork!.image!.layers!.layers).toHaveLength(2);
});

test("a corrupt provider checkpoint cannot silently submit another paid request", async () => {
  const f = await prepared();
  const batch = artworkLayerBatch({ ...f.snapshot, layerize: { saved: [] } }, f.service, f.store);
  await expect(batch.run(0, async () => {})).rejects.toMatchObject({
    fields: { code: "invalid_layer_checkpoint" },
  });
  expect(f.paid()).toBe(0);
});

test("source is rechecked immediately before provider dispatch", async () => {
  const f = await prepared();
  const batch = artworkLayerBatch(f.snapshot, f.service, f.store);
  await batch.prepare();
  await expect(
    batch.run(0, async (stage) => {
      if (stage === "generating")
        await f.store.saveRigArtwork(
          f.snapshot.source.id,
          { ...f.image, operationId: "changed" },
          f.image.operationId,
        );
    }),
  ).rejects.toMatchObject({ kind: "conflict" });
  expect(f.paid()).toBe(0);
});

test("missing options and unavailable configuration fail without paid requests", async () => {
  const f = await prepared();
  expect(() =>
    artworkLayerBatch(
      { ...f.snapshot, original: { id: f.snapshot.source.id, base: "", preview: "" } },
      f.service,
      f.store,
    ),
  ).toThrow("옵션");
  await expect(
    artworkLayerBatch(f.snapshot, undefined, f.store).run(0, async () => {}),
  ).rejects.toThrow("FAL_KEY");
  const missing = {
    ...f.snapshot,
    original: {
      ...f.snapshot.original,
      rigArtwork: {
        ...f.snapshot.original.rigArtwork!,
        image: { ...f.image, operationId: "different" },
      },
    },
  };
  expect(() => artworkLayerBatch(missing, f.service, f.store)).toThrow("옵션");
  expect(f.paid()).toBe(0);
});

test.each([
  null,
  [-1, 0, 1, 1],
  [0, -1, 1, 1],
  [0, 0, 0, 1],
  [0, 0, 1, 0],
  [0, 0, 2, 1],
  [0, 0, 1, 2],
])("invalid output placement %j cannot replace existing layers", async (bounds) => {
  const f = await prepared();
  providerOutput(f, {
    layers: [
      layerResponse.layers[0],
      {
        ...layerResponse.layers[1],
        name: null,
        bounding_box: bounds ? { absolute: bounds } : null,
      },
    ],
  });
  const batch = artworkLayerBatch(f.snapshot, f.service, f.store);
  await expect(batch.run(0, async () => {})).rejects.toMatchObject({
    fields: { code: "invalid_layer_bounds" },
  });
  expect((await f.store.rigArtwork(f.snapshot.source.id))!.layers).toBeUndefined();
});

test("the shared batch factory pins a layer task and its original model without an anime sheet", async () => {
  const f = await prepared();
  const batch = createImageBatch(
    f.snapshot.source,
    { ...f.snapshot.original, portraitInstructions: "" },
    "rig-layers",
    new URLSearchParams(),
    "rig-layers",
    { ...generator, layerize: f.service },
    f.store,
  );
  await batch.prepare();
  await batch.run(0, async () => {});
  expect(batch.finish(false).rigArtwork!.image!.layers!.model).toBe(artworkLayerModel);
  expect(f.paid()).toBe(1);
});

test("an unnamed foreground layer receives an inspectable fallback label", async () => {
  const f = await prepared();
  providerOutput(f, {
    layers: [layerResponse.layers[0], { ...layerResponse.layers[1], name: null }],
  });
  const batch = artworkLayerBatch(f.snapshot, f.service, f.store);
  await batch.run(0, async () => {});
  expect(batch.finish(false).rigArtwork!.image!.layers!.layers[1]!.name).toBe("Layer 1");
});

test.each([
  [5000, 1],
  [1, 5000],
  [4000, 4000],
])("oversized output %ix%i is refused before decoding or saving", async (width, height) => {
  const f = await prepared();
  const bytes = Buffer.from(portraitImage.bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  f.fetcher.mockImplementation(async (input, init) =>
    fetchUrl(input).endsWith("base.png") ? new Response(bytes) : layerFetch(input, init),
  );
  await expect(
    artworkLayerBatch(f.snapshot, f.service, f.store).run(0, async () => {}),
  ).rejects.toMatchObject({ fields: { code: "invalid_layer_dimensions" } });
});
