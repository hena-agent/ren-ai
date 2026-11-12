import { expect, test, vi } from "vitest";
import { serializePersona } from "@ren-ai/personas";
import { imageSize } from "image-size";
import { fixture, generator, portraitImage, character } from "../test/fixtures.ts";
import { storedLayers } from "../test/artwork-layers.ts";
import { seedreamModel } from "../test/image-models.ts";
import { emptyPersona } from "./authoring.ts";
import { createImageBatch, restoreImageBatch, type ImageBatchSnapshot } from "./image-batch.ts";
import { capturePortraitInput } from "./image-actions.ts";
import { faceReference } from "./rig-face-generation.ts";

async function setup() {
  const f = await fixture();
  const source = { ...emptyPersona, ...character, id: "face-target" };
  const imageUrl = await f.store.saveImage(portraitImage);
  const image = {
    model: seedreamModel.id,
    imageUrl,
    operationId: "art-source",
    kind: "body" as const,
  };
  await f.store.saveRigArtwork(source.id, image);
  const layers = {
    ...storedLayers(imageUrl),
    layers: storedLayers(imageUrl).layers.map((layer) => ({
      ...layer,
      name: "Face and Neck",
      plane: "face" as const,
    })),
  };
  await f.store.saveRigArtworkLayers(source.id, layers);
  const original = {
    id: source.id,
    base: "",
    preview: serializePersona(source),
    rigArtwork: {
      model: seedreamModel.id,
      selection: seedreamModel,
      image: { ...image, layers },
      face: { kind: "closed" as const, sourceLayerImageUrl: imageUrl },
    },
  };
  const input: ImageBatchSnapshot = {
    operationId: "face-operation",
    source,
    original,
    latest: original,
    current: source,
    intent: "rig-artwork",
    params: "",
    key: "rig-artwork",
    expectedBase: "",
    prompts: ["gentle smile"],
  };
  const generate = vi
    .fn<NonNullable<typeof generator.rigArtwork>>()
    .mockResolvedValue(portraitImage);
  const create = () =>
    createImageBatch(
      source,
      original,
      "rig-artwork",
      new URLSearchParams(),
      "rig-artwork",
      { ...generator, rigArtwork: generate },
      f.store,
      input,
    );
  return { ...f, source, original, input, image, layers, generate, create };
}

test("face generation uses a cropped current face on the shared batch path, persists its receipt, and recovers without another paid call", async () => {
  const f = await setup();
  const batch = f.create();
  await batch.prepare();
  batch.setPrompt(0, "soft expression");
  const stages: string[] = [];
  const url = await batch.run(0, (stage) => {
    stages.push(stage);
  });
  expect(stages).toEqual(["generating", "saving"]);
  expect(f.generate).toHaveBeenCalledOnce();
  const call = f.generate.mock.calls[0]!;
  expect(call[2]).toContain("soft expression");
  expect(call[2]).toContain("Close BOTH eyes");
  expect(call[4]).toBe("face");
  expect(imageSize(call[3].bytes)).toMatchObject({ width: 1024, height: 1536 });
  const current = (await f.store.rigArtwork(f.source.id))!;
  expect(current.imageUrl).toBe(f.image.imageUrl);
  expect(current.layers!.layers).toEqual(f.layers.layers);
  expect(current.layers!.faceSources).toMatchObject([
    { operationId: "face-operation", imageUrl: url, kind: "closed" },
  ]);
  expect(batch.finish(true)).toEqual(batch.draft());
  const recovered = restoreImageBatch(
    batch.snapshot(),
    { ...generator, rigArtwork: f.generate },
    f.store,
  );
  await recovered.prepare();
  expect(await recovered.run(0, () => {})).toBe(url);
  expect(recovered.finish(false).rigArtwork!.image!.layers!.faceSources).toHaveLength(1);
  expect(f.generate).toHaveBeenCalledOnce();
  expect(batch.record()).toEqual(f.source);
  batch.resume(f.original, [0]);
  expect(() => batch.resume({ ...f.original, base: "changed" }, [0])).toThrow("설정");
});

test("face options are scoped to the selected action and require a current face layer", async () => {
  const f = await setup();
  const form = new FormData();
  form.set("rigArtworkModel", seedreamModel.id);
  form.set("rigFaceAction", "base");
  expect(
    capturePortraitInput(f.original, form, "rig-artwork", "key", seedreamModel).rigArtwork!.face!
      .kind,
  ).toBe("base");
  form.set("rigFaceAction", "nope");
  expect(() => capturePortraitInput(f.original, form, "rig-artwork", "key", seedreamModel)).toThrow(
    "대상",
  );
  form.set("rigFaceAction", "closed");
  const withoutImage = { model: seedreamModel.id, selection: seedreamModel };
  expect(() =>
    capturePortraitInput(
      { ...f.original, rigArtwork: withoutImage },
      form,
      "rig-artwork",
      "key",
      seedreamModel,
    ),
  ).toThrow("레이어");
  form.delete("rigFaceAction");
  expect(
    capturePortraitInput(f.original, form, "rig-artwork", "key", seedreamModel).rigArtwork!.face,
  ).toBeUndefined();
  form.set("rigFaceAction", "");
  expect(
    capturePortraitInput(f.original, form, "rig-artwork", "key", seedreamModel).rigArtwork!.face,
  ).toBeUndefined();
  form.set("rigFaceAction", "closed");
  const named = {
    ...f.original,
    rigArtwork: {
      ...f.original.rigArtwork,
      image: {
        ...f.original.rigArtwork.image,
        layers: {
          ...f.layers,
          layers: f.layers.layers.map((layer) => ({ ...layer, plane: "body" as const })),
        },
      },
    },
  };
  expect(
    capturePortraitInput(named, form, "rig-artwork", "key", seedreamModel).rigArtwork!.face!.kind,
  ).toBe("closed");
  const unclassified = {
    ...named,
    rigArtwork: {
      ...named.rigArtwork,
      image: {
        ...named.rigArtwork.image,
        layers: {
          ...named.rigArtwork.image.layers,
          layers: named.rigArtwork.image.layers.layers.map((layer) => ({
            ...layer,
            name: "Torso",
          })),
        },
      },
    },
  };
  expect(() =>
    capturePortraitInput(unclassified, form, "rig-artwork", "key", seedreamModel),
  ).toThrow("레이어");
  form.set("rigArtworkTarget", "outfit");
  expect(() => capturePortraitInput(f.original, form, "rig-artwork", "key", seedreamModel)).toThrow(
    "레이어",
  );
});

test("changed bodies and exhausted face capacity stop before payment; provider failure preserves the body", async () => {
  const f = await setup();
  f.generate.mockRejectedValueOnce(new Error("provider unavailable"));
  await expect(f.create().run(0, () => {})).rejects.toThrow("provider unavailable");
  expect((await f.store.rigArtwork(f.source.id))!.layers).toEqual(f.layers);
  await f.store.saveRigArtworkLayers(
    f.source.id,
    {
      ...f.layers,
      operationId: "full",
      faceSources: Array.from({ length: 12 }, () => ({
        kind: "base" as const,
        operationId: "other",
        model: "test",
        imageUrl: f.image.imageUrl,
        bounds: [0, 0, 1, 1] as const,
      })),
    },
    f.layers.operationId,
  );
  await expect(f.create().run(0, () => {})).rejects.toThrow("정리");
  await f.store.saveRigArtwork(
    f.source.id,
    { ...f.image, operationId: "changed" },
    f.image.operationId,
  );
  await expect(f.create().prepare()).rejects.toThrow("변경");
  expect(f.generate).toHaveBeenCalledOnce();
});

test("missing generation configuration and malformed face geometry cannot consume a paid call", async () => {
  const f = await setup();
  const batch = restoreImageBatch(f.input, generator, f.store);
  await expect(batch.run(0, () => {})).rejects.toMatchObject({ fields: { code: "missing_key" } });
  expect(() =>
    faceReference(
      portraitImage.bytes,
      { ...f.image, layers: f.layers },
      { ...f.layers.layers[0]!, bounds: [0, 0, 0, 1] },
    ),
  ).toThrow("위치");
  expect(f.generate).not.toHaveBeenCalled();
});
