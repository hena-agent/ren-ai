import {
  PersonaError,
  serializePersona,
  validatePortrait,
  type PersonaStore,
  type RigArtworkImage,
} from "@ren-ai/personas";
import { splitPersonaMarkdown } from "@ren-ai/personas/profile";
import type { Draft } from "./draft.ts";
import { completedImageDraft, previewOf } from "./draft.ts";
import { characterOf, emptyPersona } from "./authoring.ts";
import type { ImageBatch, ImageBatchSnapshot } from "./image-batch.ts";
import type { RigArtworkGenerator } from "./rig-artwork-generation.ts";
import { GenerationError, operation } from "./logging.ts";
import { assertSnapshot } from "./snapshot.ts";
import { requireSheetReferences, assertSheets } from "./identity-sheets.ts";
import { readPortraitReference } from "./portrait-images.ts";
import { imageProviders } from "./image-model.ts";
import { artworkAsset, requireRigBody } from "./rig-artwork-target.ts";
import { rigFaceBatch } from "./rig-face-batch.ts";

export function rigArtworkBatch(
  snapshot: ImageBatchSnapshot,
  generate: RigArtworkGenerator | undefined,
  store: PersonaStore,
): ImageBatch {
  const selected = snapshot.original.rigArtwork;
  if (!selected) throw new PersonaError("invalid", "원화 제작 옵션이 없습니다.");
  const selection = selected.selection;
  if (!selection || selection.id !== selected.model)
    throw new PersonaError(
      "invalid",
      "확인한 모델 카탈로그 정보가 없습니다. 모델을 다시 선택하세요.",
    );
  if (selected.face) return rigFaceBatch(snapshot, generate, store);
  const slots = [{ style: "anime" as const, index: 0 }];
  const target = selected.target ?? "body";
  if (target === "outfit") requireRigBody(selected.image);
  else requireSheetReferences(snapshot.original, slots);
  let latest = snapshot.latest;
  const prompts = [...snapshot.prompts];
  const source = snapshot.source;
  const currentArtwork = async () => {
    const current = await operation("rig.artwork.read", {}, () => store.rigArtwork(source.id));
    if (target === "outfit" && requireRigBody(current).operationId !== selected.image!.operationId)
      throw new PersonaError("conflict", "기본 몸이 변경되었습니다. 의상 옵션을 다시 확인하세요.");
    const asset = artworkAsset(current, target);
    if (
      asset?.operationId !== artworkAsset(selected.image, target)?.operationId &&
      asset?.operationId !== snapshot.operationId
    )
      throw new PersonaError("conflict", "원화가 변경되었습니다. 다시 열어 주세요.");
    return current;
  };
  return {
    intent: "rig-artwork",
    personaId: source.id,
    source,
    slots,
    prompts,
    draft: () => latest,
    record: () => source,
    prepare: async () => {
      await assertSnapshot(store, latest);
      const current = await currentArtwork();
      if (current) latest = { ...latest, rigArtwork: { ...selected, image: current } };
      if (target === "body" && current?.operationId !== snapshot.operationId)
        await assertSheets(store, snapshot.original, slots);
    },
    run: async (_ordinal, stage) => {
      if (target === "outfit") {
        const image = await currentArtwork();
        latest = { ...latest, rigArtwork: { ...selected, image: image! } };
      }
      const completed = artworkAsset(latest.rigArtwork?.image, target);
      if (completed?.operationId === snapshot.operationId) return completed.imageUrl;
      if (!generate)
        throw new GenerationError(`${imageProviders[selection.provider].key} is required`, {
          model: selected.model,
          code: "missing_key",
        });
      const reference = await readPortraitReference(
        target === "outfit" ? selected.image!.imageUrl : snapshot.original.sheets!.anime!,
        "anime",
        store,
      );
      validatePortrait(reference);
      await stage("generating");
      if (target === "body") await assertSheets(store, snapshot.original, slots);
      else await currentArtwork();
      const character = characterOf(source);
      const image = await generate(
        selection,
        `${character.name}\n${splitPersonaMarkdown(character.description).privateMarkdown}`,
        prompts[0]!,
        reference,
        target,
      );
      await stage("saving");
      const imageUrl = await operation("rig.artwork.save", {}, () => store.saveImage(image));
      const asset = { model: selected.model, imageUrl, operationId: snapshot.operationId };
      const artwork: RigArtworkImage =
        target === "body"
          ? { ...asset, kind: "body" as const }
          : {
              ...latest.rigArtwork!.image!,
              outfit: { ...asset, sourceOperationId: selected.image!.operationId },
            };
      await operation("rig.artwork.link", {}, () =>
        target === "outfit"
          ? store.saveRigArtworkOutfit(
              source.id,
              artwork.outfit!,
              selected.image?.outfit?.operationId,
            )
          : store.saveRigArtwork(source.id, artwork, selected.image?.operationId),
      );
      latest = {
        ...latest,
        imageEditing: true,
        preview: serializePersona(source),
        rigArtwork: {
          model: selected.model,
          image: artwork,
          target,
        },
      };
      return imageUrl;
    },
    setPrompt: (_ordinal, prompt) => {
      prompts[0] = prompt;
    },
    finish: (failed) => {
      if (!failed) latest = completedImageDraft(latest);
      return latest;
    },
    resume: (editing: Draft) => {
      const persona = previewOf(editing, emptyPersona);
      if (JSON.stringify(characterOf(persona)) !== JSON.stringify(characterOf(source)))
        throw new PersonaError(
          "conflict",
          "페르소나 설명이 변경되었습니다. 원화 옵션을 다시 확인하세요.",
        );
      if (target === "body" && editing.sheets?.anime !== snapshot.original.sheets!.anime)
        throw new PersonaError(
          "conflict",
          "애니메 인물 시트가 변경되었습니다. 원화 옵션을 다시 확인하세요.",
        );
      latest = { ...editing, rigArtwork: { ...editing.rigArtwork, model: selected.model, target } };
    },
    snapshot: () => ({ ...snapshot, latest, prompts }),
  };
}
