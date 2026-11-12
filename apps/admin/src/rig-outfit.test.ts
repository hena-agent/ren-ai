import { expect, test, vi } from "vitest";
import { serializePersona } from "@ren-ai/personas";
import { ownedImageKey } from "@ren-ai/personas/image-url";
import { fixture, legacy, portraitImage, generator, request } from "../test/fixtures.ts";
import { storedLayers, layerService } from "../test/artwork-layers.ts";
import { seedreamModel } from "../test/image-models.ts";
import { createImageBatch, restoreImageBatch } from "./image-batch.ts";
import { capturePortraitInput } from "./image-actions.ts";
import { captureArtworkLayers, artworkLayerOptions } from "./artwork-layer-options.ts";
import { artworkTarget, requireRigBody } from "./rig-artwork-target.ts";

async function prepared() {
  const { store, admin } = await fixture();
  await store.create(legacy);
  const imageUrl = await store.saveImage(portraitImage);
  const body = {
    model: seedreamModel.id,
    imageUrl,
    operationId: "body",
    kind: "body" as const,
    layers: storedLayers(imageUrl, "body"),
  };
  await store.saveRigArtwork(legacy.id, body);
  const draft = {
    id: legacy.id,
    base: serializePersona(legacy),
    preview: serializePersona(legacy),
    rigArtwork: {
      model: seedreamModel.id,
      selection: seedreamModel,
      image: body,
      target: "outfit" as const,
    },
  };
  const generate = vi
    .fn<NonNullable<typeof generator.rigArtwork>>()
    .mockResolvedValue(portraitImage);
  const batch = createImageBatch(
    legacy,
    draft,
    "rig-artwork",
    new URLSearchParams(),
    "outfit",
    { ...generator, rigArtwork: generate },
    store,
  );
  return { store, admin, body, draft, generate, batch };
}

test("outfit generation references the stored body, preserves body layers and recovers its own receipt", async () => {
  const { store, body, draft, generate, batch } = await prepared();
  const read = vi.spyOn(store, "image");
  const checkpoint = batch.snapshot();
  await batch.prepare();
  batch.resume(draft, [0]);
  batch.setPrompt(0, "black dress and wrist ribbons");
  const imageUrl = await batch.run(0, async () => {});
  expect(read).toHaveBeenCalledWith(ownedImageKey(body.imageUrl));
  expect(generate.mock.calls[0]!.slice(2)).toEqual([
    "black dress and wrist ribbons",
    portraitImage,
    "outfit",
  ]);
  const current = await store.rigArtwork(legacy.id);
  expect(current).toMatchObject({
    ...body,
    outfit: { imageUrl, sourceOperationId: body.operationId, operationId: checkpoint.operationId },
  });
  const recovered = restoreImageBatch(checkpoint, { ...generator, rigArtwork: generate }, store);
  await recovered.prepare();
  expect(await recovered.run(0, async () => {})).toBe(imageUrl);
  expect(generate).toHaveBeenCalledTimes(1);
  expect(batch.finish(false).rigArtwork!.image!.outfit!.imageUrl).toBe(imageUrl);
  expect(JSON.stringify(await store.get(legacy.id))).not.toContain("outfit");
});

test("body replacement and newer outfits fence queued work before a paid request", async () => {
  const { store, body, batch, generate } = await prepared();
  await store.saveRigArtworkOutfit(legacy.id, {
    model: body.model,
    imageUrl: body.imageUrl,
    operationId: "newer-outfit",
    sourceOperationId: body.operationId,
  });
  await expect(batch.prepare()).rejects.toMatchObject({ kind: "conflict" });
  await store.saveRigArtwork(legacy.id, { ...body, operationId: "new-body" }, body.operationId);
  expect((await store.rigArtwork(legacy.id))!.outfit).toBeUndefined();
  await expect(batch.run(0, async () => {})).rejects.toThrow("기본 몸이 변경");
  expect(generate).not.toHaveBeenCalled();
});

test("body changes during reference reading are detected before outfit generation", async () => {
  const { store, body, batch, generate } = await prepared();
  const read = store.image;
  vi.spyOn(store, "image").mockImplementation(async (url) => {
    const image = await read(url);
    await store.saveRigArtwork(legacy.id, { ...body, operationId: "changed" }, body.operationId);
    return image;
  });
  await expect(batch.run(0, async () => {})).rejects.toThrow("기본 몸이 변경");
  expect(generate).not.toHaveBeenCalled();
});

test("body and outfit are explicit submission targets and missing base bodies cannot be dressed", async () => {
  const { draft, body } = await prepared();
  expect(artworkTarget(null)).toBe("body");
  expect(artworkTarget("outfit")).toBe("outfit");
  expect(() => artworkTarget("arbitrary")).toThrow("기본 몸 또는 의상");
  expect(() => requireRigBody(undefined)).toThrow("기본 몸");
  expect(() =>
    requireRigBody({
      model: body.model,
      operationId: body.operationId,
      imageUrl: body.imageUrl,
      kind: "body",
    }),
  ).toThrow("검수");
  const form = new FormData();
  form.set("rigArtworkTarget", "outfit");
  form.set("rigArtworkModel", seedreamModel.id);
  expect(
    capturePortraitInput(draft, form, "rig-artwork", "outfit", seedreamModel).rigArtwork!.target,
  ).toBe("outfit");
  expect(() =>
    capturePortraitInput(
      { ...draft, rigArtwork: { model: body.model } },
      form,
      "rig-artwork",
      "outfit",
      seedreamModel,
    ),
  ).toThrow("기본 몸");
});

test("outfit layer generation, inspection, layout editing and recovery leave body layers untouched", async () => {
  const { store, admin, body, batch, draft } = await prepared();
  expect((await admin(request(`/personas/${legacy.id}/artwork-layers?target=outfit`))).status).toBe(
    404,
  );
  await batch.prepare();
  await batch.run(0, async () => {});
  const editor = await (await admin(request(`/personas/${legacy.id}`))).text();
  expect(editor).toContain("의상 원본 열기");
  expect(editor).toContain("의상 다시 생성");
  const current = (await store.rigArtwork(legacy.id))!;
  const { service } = layerService();
  const selection = await service.options(current.outfit!.operationId);
  const form = new FormData();
  form.set("rigArtworkTarget", "outfit");
  form.set("layerizeQuote", selection.quote);
  const input = captureArtworkLayers(
    { ...draft, rigArtwork: { ...draft.rigArtwork, image: current } },
    form,
    "rig-layers",
    service,
  );
  const layers = createImageBatch(
    legacy,
    input,
    "rig-layers",
    new URLSearchParams(),
    "outfit-layers",
    { ...generator, layerize: service },
    store,
  );
  await layers.prepare();
  await layers.run(0, async () => {});
  const completed = (await store.rigArtwork(legacy.id))!;
  expect(completed.layers).toEqual(body.layers);
  expect(completed.outfit!.layers!.sourceOperationId).toBe(current.outfit!.operationId);
  const resumed = restoreImageBatch(layers.snapshot(), { ...generator, layerize: service }, store);
  await resumed.run(0, async () => {});
  const page = await admin(request(`/personas/${legacy.id}/artwork-layers?target=outfit`));
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('name="rigArtworkTarget" value="outfit"');
  const params = new URLSearchParams({
    persona: legacy.id,
    target: "outfit",
    source: current.outfit!.operationId,
  });
  expect(
    (await artworkLayerOptions(request(`/artwork-layer-options?${params}`), store, service)).status,
  ).toBe(200);
  const layout = await admin(
    request(`/personas/${legacy.id}/artwork-layers/layout`, {
      rigArtworkTarget: "outfit",
      source: current.outfit!.operationId,
      result: completed.outfit!.layers!.operationId,
      layer: "1",
      x: "0",
      y: "0",
      width: "0.5",
      height: "0.5",
    }),
  );
  expect(layout.status).toBe(303);
  expect(layout.headers.get("location")).toContain("target=outfit");
  expect((await store.rigArtwork(legacy.id))!.layers).toEqual(body.layers);
  const rig = await (await admin(request(`/personas/${legacy.id}/rig-test`))).text();
  expect(rig).toContain('data-rig-texture="body-1"');
  expect(rig).toContain('data-rig-texture="outfit-1"');
});
