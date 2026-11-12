import { expect, test, vi } from "vitest";
import { emptyPersona } from "./authoring.ts";
import type { Draft } from "./draft.ts";
import type { ImageBatchSnapshot } from "./image-batch.ts";
import { createImageBatch, restoreImageBatch } from "./image-batch.ts";
import { rigArtworkBatch } from "./rig-artwork-batch.ts";
import { fixture, generator, portraitImage, character, seedSheets } from "../test/fixtures.ts";
import { serializePersona } from "@ren-ai/personas";
import { splitPersonaMarkdown } from "@ren-ai/personas/profile";
import { seedreamModel } from "../test/image-models.ts";
import { capturePortraitInput } from "./image-actions.ts";

function snapshot(anime = "/images/11111111-1111-4111-8111-111111111111.png"): ImageBatchSnapshot {
  const source = {
    ...emptyPersona,
    ...character,
    prompt: character.description,
    id: "artwork-persona",
  };
  const original: Draft = {
    id: source.id,
    base: "",
    preview: serializePersona(source),
    rigArtwork: { model: seedreamModel.id, selection: seedreamModel },
    sheets: { anime },
  };
  return {
    operationId: "operation",
    source,
    original,
    current: source,
    latest: original,
    intent: "rig-artwork",
    params: "",
    key: "key",
    prompts: ["original"],
    expectedBase: "",
  };
}

async function seededBatchFixture() {
  const { store } = await fixture();
  const sheets = await seedSheets(store, "artwork-persona");
  const generate = vi
    .fn<NonNullable<typeof generator.rigArtwork>>()
    .mockResolvedValue(portraitImage);
  return { store, sheets, generate };
}

test("a restored persona artwork keeps its model and prompt and reuses its saved result without paying twice", async () => {
  const { store, sheets, generate } = await seededBatchFixture();
  const batch = rigArtworkBatch(snapshot(sheets.anime), generate, store);
  batch.setPrompt(0, "corrected direction");
  const restored = restoreImageBatch(
    batch.snapshot(),
    { ...generator, rigArtwork: generate },
    store,
  );
  await restored.prepare();
  const stages: string[] = [];
  const imageUrl = await restored.run(0, (stage) => {
    stages.push(stage);
  });
  expect(stages).toEqual(["generating", "saving"]);
  expect(generate).toHaveBeenCalledWith(
    seedreamModel,
    `${character.name}\n${splitPersonaMarkdown(character.description).privateMarkdown}`,
    "corrected direction",
    portraitImage,
    "body",
  );
  const finished = restored.finish(false);
  expect(finished.rigArtwork!.image).toMatchObject({ imageUrl, model: seedreamModel.id });
  const again = restoreImageBatch(
    restored.snapshot(),
    { ...generator, rigArtwork: generate },
    store,
  );
  expect(await again.run(0, async () => {})).toBe(imageUrl);
  expect(generate).toHaveBeenCalledTimes(1);
  expect(again.record().imageUrl).toBe("");
  expect(again.finish(true).rigArtwork!.image!.imageUrl).toBe(imageUrl);
  const checkpointLost = restoreImageBatch(
    snapshot(sheets.anime),
    { ...generator, rigArtwork: generate },
    store,
  );
  await checkpointLost.prepare();
  expect(await checkpointLost.run(0, async () => {})).toBe(imageUrl);
  expect(generate).toHaveBeenCalledTimes(1);
});

test("missing options, changed persona and removal of provider credentials fail before any paid call", async () => {
  const { store } = await fixture();
  const input = snapshot();
  const missing = { id: input.source.id, base: "", preview: "" };
  expect(() => rigArtworkBatch({ ...input, original: missing }, undefined, store)).toThrow("옵션");
  const batch = rigArtworkBatch(input, undefined, store);
  await expect(batch.run(0, async () => {})).rejects.toThrow("FAL_KEY");
  expect(() => batch.resume(missing, [0])).toThrow("설명");
  const withoutSheet = { ...input.latest };
  delete withoutSheet.sheets;
  expect(() => batch.resume(withoutSheet, [0])).toThrow("인물 시트");
  batch.resume(input.latest, [0]);
  expect(batch.draft().id).toBe(input.source.id);
});

test("missing or substituted model contracts are rejected before queueing or restoring paid work", async () => {
  const { store } = await fixture();
  const input = snapshot();
  const form = new FormData();
  form.set("rigArtworkModel", seedreamModel.id);
  for (const selection of [undefined, { ...seedreamModel, id: "openai:substituted" }]) {
    expect(() =>
      capturePortraitInput(input.original, form, "rig-artwork", "key", selection),
    ).toThrow("카탈로그");
    const original = {
      ...input.original,
      rigArtwork: { model: seedreamModel.id, ...(selection ? { selection } : {}) },
    };
    expect(() => rigArtworkBatch({ ...input, original }, undefined, store)).toThrow("카탈로그");
  }
});

test.each([undefined, "saved optional direction"])(
  "an artwork batch without per-image prompts retains its optional direction (%s)",
  async (portraitInstructions) => {
    const { store } = await fixture();
    const input = snapshot();
    const draft = {
      ...input.original,
      ...(portraitInstructions === undefined ? {} : { portraitInstructions }),
    };
    const batch = createImageBatch(
      input.source,
      draft,
      "rig-artwork",
      new URLSearchParams(),
      "key",
      generator,
      store,
    );
    expect(batch.prompts).toEqual([portraitInstructions ?? ""]);
  },
);

test("a newer stored artwork rejects an old queued replacement before paying and preserves the current link", async () => {
  const { store } = await fixture();
  const generate = vi
    .fn<NonNullable<typeof generator.rigArtwork>>()
    .mockResolvedValue(portraitImage);
  const queued = snapshot();
  const current = {
    model: "flux-2-klein-9b" as const,
    operationId: "newer-operation",
    imageUrl: await store.saveImage(portraitImage),
  };
  await store.saveRigArtwork(queued.source.id, current);
  const batch = rigArtworkBatch(queued, generate, store);
  await expect(batch.prepare()).rejects.toMatchObject({ kind: "conflict" });
  expect(generate).not.toHaveBeenCalled();
  expect(await store.rigArtwork(queued.source.id)).toEqual(current);
});

test("a sheet change after reading the reference but before dispatch still blocks the paid call", async () => {
  const { store, sheets, generate } = await seededBatchFixture();
  const batch = rigArtworkBatch(snapshot(sheets.anime), generate, store);
  await batch.prepare();
  const replacement = await store.saveImage(portraitImage);
  await expect(
    batch.run(0, async (stage) => {
      if (stage === "generating")
        await store.saveSheet("artwork-persona", "anime", replacement, sheets.anime);
    }),
  ).rejects.toMatchObject({ kind: "conflict" });
  expect(generate).not.toHaveBeenCalled();
});
