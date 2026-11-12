import { randomUUID } from "node:crypto";
import { PersonaError, type PersonaStore } from "@ren-ai/personas";
import type { ImageBatch, ImageBatchSnapshot } from "./image-batch.ts";
import type { RigArtworkGenerator } from "./rig-artwork-generation.ts";
import { completedImageDraft } from "./draft.ts";
import { assertSnapshot } from "./snapshot.ts";
import { GenerationError, operation } from "./logging.ts";
import { readPortraitReference } from "./portrait-images.ts";
import { faceReference, faceGenerationDirections } from "./rig-face-generation.ts";
import { artworkBatchFields } from "./artwork-batch-fields.ts";

export function rigFaceBatch(
  snapshot: ImageBatchSnapshot,
  generate: RigArtworkGenerator | undefined,
  store: PersonaStore,
): ImageBatch {
  const selected = snapshot.original.rigArtwork!;
  const selection = selected.selection!;
  const face = selected.face!;
  let latest = snapshot.latest;
  const prompts = [...snapshot.prompts];
  const current = async () => {
    const artwork = await operation("rig.face.read", {}, () =>
      store.rigArtwork(snapshot.source.id),
    );
    const layer = artwork?.layers?.layers.find(
      (part) => part.imageUrl === face.sourceLayerImageUrl,
    );
    if (
      !artwork?.layers ||
      artwork.kind !== "body" ||
      artwork.operationId !== selected.image?.operationId ||
      !layer
    )
      throw new PersonaError(
        "conflict",
        "기본 몸 또는 얼굴 레이어가 변경되었습니다. 다시 확인하세요.",
      );
    return { artwork, layer, layers: artwork.layers };
  };
  return {
    intent: "rig-artwork",
    ...artworkBatchFields(snapshot, () => latest, prompts),
    prepare: async () => {
      await assertSnapshot(store, latest);
      await current();
    },
    run: async (_ordinal, stage) => {
      const saved = await current();
      const recovered = saved.layers.faceSources?.find(
        (source) => source.operationId === snapshot.operationId,
      );
      if (recovered) {
        latest = { ...latest, rigArtwork: { ...selected, image: saved.artwork } };
        return recovered.imageUrl;
      }
      if ((saved.layers.faceSources?.length ?? 0) >= 12)
        throw new PersonaError("invalid", "얼굴 생성 결과를 정리한 뒤 다시 제작하세요.");
      if (!generate)
        throw new GenerationError("이미지 생성 연결이 필요합니다.", {
          model: selected.model,
          code: "missing_key",
        });
      const original = await readPortraitReference(saved.artwork.imageUrl, "anime", store);
      const reference = faceReference(original.bytes, saved.artwork, saved.layer);
      await stage("generating");
      const image = await generate(
        selection,
        "",
        `${faceGenerationDirections[face.kind]}\n\nOPTIONAL OPERATOR DIRECTION:\n${prompts[0]!}`,
        reference.portrait,
        "face",
      );
      await stage("saving");
      const imageUrl = await operation("rig.face.image.save", { model: selected.model }, () =>
        store.saveImage(image),
      );
      const fresh = await current();
      const layers = {
        ...fresh.layers,
        operationId: randomUUID(),
        generationOperationId: fresh.layers.generationOperationId ?? fresh.layers.operationId,
        faceSources: [
          ...(fresh.layers.faceSources ?? []),
          {
            kind: face.kind,
            operationId: snapshot.operationId,
            model: selected.model,
            imageUrl,
            bounds: reference.bounds,
          },
        ],
      };
      await operation("rig.face.link", {}, () =>
        store.saveRigArtworkLayers(snapshot.source.id, layers, fresh.layers.operationId),
      );
      latest = {
        ...latest,
        imageEditing: true,
        rigArtwork: { ...selected, image: { ...fresh.artwork, layers } },
      };
      return imageUrl;
    },
    setPrompt: (_ordinal, prompt) => {
      prompts[0] = prompt;
    },
    finish: (failed) => (failed ? latest : completedImageDraft(latest)),
    resume: (editing) => {
      if (editing.base !== snapshot.original.base || editing.preview !== snapshot.original.preview)
        throw new PersonaError("conflict", "페르소나 설정이 변경되었습니다. 다시 확인하세요.");
      latest = { ...editing, rigArtwork: selected };
    },
    snapshot: () => ({ ...snapshot, latest, prompts }),
  };
}
