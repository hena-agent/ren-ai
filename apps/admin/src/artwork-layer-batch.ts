import { Schema } from "effect";
import { imageSize } from "image-size";
import {
  PersonaError,
  RigArtworkLayers,
  type PersonaStore,
  type RigArtworkImage,
  type RigArtworkLayer,
  type Portrait,
} from "@ren-ai/personas";
import { ArtworkLayerCheckpoint, type ArtworkLayerResponse } from "./artwork-layer-model.ts";
import type { ArtworkLayerizer } from "./artwork-layer-generation.ts";
import type { ImageBatch, ImageBatchSnapshot } from "./image-batch.ts";
import { completedImageDraft, type Draft } from "./draft.ts";
import { readPortraitReference } from "./portrait-images.ts";
import { assertSnapshot } from "./snapshot.ts";
import { GenerationError, operation } from "./logging.ts";
import { artworkAsset } from "./rig-artwork-target.ts";
import { artworkBatchFields } from "./artwork-batch-fields.ts";

function layerMetadata(
  layer: ArtworkLayerResponse["layers"][number],
  image: Portrait,
  base: RigArtworkLayer | undefined,
) {
  const dimensions = imageSize(image.bytes);
  if (
    dimensions.width > 4096 ||
    dimensions.height > 4096 ||
    dimensions.width * dimensions.height > 9_437_184
  )
    throw new GenerationError("Layer image dimensions exceed the supported output size", {
      code: "invalid_layer_dimensions",
    });
  const bounds =
    layer.z_index === 0
      ? ([0, 0, dimensions.width, dimensions.height] as const)
      : layer.bounding_box?.absolute;
  if (
    !bounds ||
    bounds[0] < 0 ||
    bounds[1] < 0 ||
    bounds[2] <= bounds[0] ||
    bounds[3] <= bounds[1] ||
    (base && (bounds[2] > base.width || bounds[3] > base.height))
  )
    throw new GenerationError("Invalid layer bounds", { code: "invalid_layer_bounds" });
  return {
    name: (layer.name ?? (layer.z_index === 0 ? "Base" : "Layer " + layer.z_index)).slice(0, 160),
    zIndex: layer.z_index,
    width: dimensions.width,
    height: dimensions.height,
    bounds,
  };
}

export function artworkLayerBatch(
  snapshot: ImageBatchSnapshot,
  service: ArtworkLayerizer | undefined,
  store: PersonaStore,
): ImageBatch {
  const target = snapshot.original.rigArtwork?.target ?? "body";
  const source = artworkAsset(snapshot.original.rigArtwork?.image, target);
  const selection = snapshot.original.rigArtwork?.layerize;
  if (!source || !selection || source.operationId !== selection.sourceOperationId)
    throw new PersonaError("invalid", "현재 원화의 레이어 분리 옵션을 확인하세요.");
  let latest = snapshot.latest;
  let state: ArtworkLayerCheckpoint | undefined =
    snapshot.layerize && Schema.decodeUnknownSync(ArtworkLayerCheckpoint)(snapshot.layerize);
  const prompts = [...snapshot.prompts];
  const completed = (image: RigArtworkImage) =>
    image.layers?.operationId === snapshot.operationId ||
    image.layers?.generationOperationId === snapshot.operationId;
  const current = async () => {
    const root = await operation("rig.layers.source", {}, () =>
      store.rigArtwork(snapshot.source.id),
    );
    const image = artworkAsset(root, target);
    if (!image || image.operationId !== source.operationId || image.imageUrl !== source.imageUrl)
      throw new PersonaError(
        "conflict",
        "원화가 변경되었습니다. 새 원화의 레이어 분리 옵션을 확인하세요.",
      );
    if (!completed(image) && image.layers?.operationId !== source.layers?.operationId)
      throw new PersonaError("conflict", "레이어가 변경되었습니다. 다시 열어 주세요.");
    return { root: root!, image };
  };
  const adopt = (image: RigArtworkImage) => {
    latest = { ...latest, rigArtwork: { ...latest.rigArtwork!, image } };
  };
  return {
    intent: "rig-layers",
    ...artworkBatchFields(snapshot, () => latest, prompts),
    prepare: async () => {
      await assertSnapshot(store, latest);
      adopt((await current()).root);
    },
    run: async (_ordinal, stage) => {
      const { root, image } = await current();
      if (completed(image)) {
        adopt(root);
        return image.imageUrl;
      }
      if (!service) throw new GenerationError("FAL_KEY is required", { code: "missing_key" });
      if (!state) {
        const reference = await readPortraitReference(source.imageUrl, "anime", store);
        await stage("generating");
        await current();
        const response = await service.generate(
          selection,
          prompts[0]!,
          reference,
          async (requestId) => {
            state = { requestId, saved: [] };
            await stage("generating");
          },
          target,
        );
        state = { response, saved: [] };
      } else if (!state.response) {
        if (!state.requestId)
          throw new GenerationError("Missing layer provider receipt", {
            code: "invalid_layer_checkpoint",
          });
        state = { ...state, response: await service.resume(state.requestId) };
      }
      await stage("saving");
      const output = state.response!;
      while (state.saved.length < output.layers.length) {
        const layer: ArtworkLayerResponse["layers"][number] = output.layers[state.saved.length]!;
        const bytes = await service.download(layer.image.url);
        const metadata = layerMetadata(layer, bytes, state.saved[0]);
        const imageUrl = await operation("rig.layers.save", {}, () => store.saveImage(bytes));
        const saved: RigArtworkLayer = {
          ...metadata,
          imageUrl,
        };
        state = { ...state, saved: [...state.saved, saved] };
        await stage("saving");
      }
      await current();
      const layers: RigArtworkLayers = {
        operationId: snapshot.operationId,
        sourceOperationId: source.operationId,
        model: selection.model,
        width: state.saved[0]!.width,
        height: state.saved[0]!.height,
        layers: state.saved,
      };
      await operation("rig.layers.link", {}, () =>
        store.saveRigArtworkLayers(snapshot.source.id, layers, source.layers?.operationId, target),
      );
      adopt(
        target === "outfit"
          ? { ...root, outfit: { ...root.outfit!, layers } }
          : { ...root, layers },
      );
      return image.imageUrl;
    },
    setPrompt: (_ordinal, prompt) => {
      if (state && prompt !== prompts[0])
        throw new PersonaError(
          "invalid",
          "이미 분리된 결과는 원래 지시 그대로 저장만 재시도할 수 있습니다.",
        );
      prompts[0] = prompt;
    },
    finish: (failed) => {
      if (!failed) {
        latest = completedImageDraft(latest);
        state = undefined;
      }
      return latest;
    },
    resume: (editing: Draft) => {
      latest = { ...editing, rigArtwork: { ...editing.rigArtwork!, layerize: selection } };
    },
    snapshot: () => {
      const { layerize: _previous, ...base } = snapshot;
      return { ...base, latest, prompts, ...(state && { layerize: state }) };
    },
  };
}
