import type { Draft } from "./draft.ts";
import { readPortraitInstructions, readIntent } from "./authoring.ts";
import { previewOf } from "./draft.ts";
import { emptyPersona } from "./authoring.ts";
import { latestImageDraft, regenerationKey } from "./regenerate-portrait.ts";
import { PersonaError } from "@ren-ai/personas";
import copy from "./copy.json";
import { readImageCount } from "./image-count.ts";
import { readImagePrompts } from "./image-prompts.ts";
import { protect } from "./logging.ts";
import { createHash } from "node:crypto";
import { isSheetIntent, isArtworkIntent, isExclusiveImageIntent } from "./image-slots.ts";
import { imageStyle } from "./portrait-images.ts";
import type { ImageModelSelection } from "./image-model.ts";
import { artworkTarget, requireRigBody } from "./rig-artwork-target.ts";
import { RigFaceGenerationKind } from "@ren-ai/personas/rig-artwork";
import { Schema, Option } from "effect";

function adoptPhotos(original: Draft, latest: Draft | undefined) {
  if (!latest || latest.base !== original.base) return original;
  const next = { ...latest };
  delete next.sheets;
  if (original.sheets) next.sheets = original.sheets;
  return next;
}

export function imageRequestKey(
  request: Request,
  personaId: string,
  intent: string,
  form: FormData,
  search: string,
) {
  const registration = request.headers.get("x-image-request");
  if (registration !== null && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(registration))
    throw new PersonaError("invalid", copy.formError);
  const identity = registration
    ? [personaId, registration]
    : [
        form.get("draft"),
        intent,
        search,
        form.get("portraitInstructions"),
        form.get("imageDirection"),
        form.get("imageCount"),
        form.getAll("imagePrompts"),
        form.get("separateImagePrompts"),
        form.get("rigArtworkModel"),
        form.get("rigArtworkQuote"),
        form.get("layerizeQuote"),
        form.get("rigArtworkTarget"),
        form.get("rigFaceAction"),
      ];
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function protectEditingForm(form: FormData) {
  protect(
    ...[
      "draft",
      "name",
      "description",
      "seed",
      "portraitInstructions",
      "imageDirection",
      "imagePrompts",
      "publicBlock",
      "publicAddition",
      "stateSource",
      "memorySource",
      "improvementInstructions",
      "rigArtworkQuote",
      "layerizeQuote",
    ].flatMap((key) =>
      form.getAll(key).filter((value): value is string => typeof value === "string"),
    ),
  );
}

export function imageSubmission(
  draft: Draft,
  latest: Draft | undefined,
  intent: ReturnType<typeof readIntent>,
  params: URLSearchParams,
) {
  if (latest?.base === draft.base && latest.rigArtwork)
    draft = { ...draft, rigArtwork: latest.rigArtwork };
  if (intent === "delete-image")
    return {
      key: regenerationKey(previewOf(draft, emptyPersona), params),
      draft: latest?.base === draft.base ? latest : draft,
    };
  if (intent === "regenerate")
    return {
      key: regenerationKey(previewOf(draft, emptyPersona), params),
      draft: latestImageDraft(draft, latest, params),
    };
  if (intent === "generate" || isSheetIntent(intent) || isArtworkIntent(intent))
    return {
      key: isArtworkIntent(intent)
        ? intent
        : intent === "sheets"
          ? "sheets"
          : intent === "sheet"
            ? `sheet:${imageStyle(params)}:${params.get("image") ?? draft.sheets?.[imageStyle(params)] ?? "new"}`
            : `generate:${imageStyle(params)}`,
      draft: adoptPhotos(draft, latest),
    };
  return { key: intent, draft };
}

function captureFaceAction(draft: Draft, form: FormData, target: "body" | "outfit") {
  const value = form.get("rigFaceAction");
  if (value === null || value === "") return {};
  const kind = Schema.decodeUnknownOption(RigFaceGenerationKind)(value);
  if (Option.isNone(kind)) throw new PersonaError("invalid", "얼굴 제작 대상을 확인하세요.");
  const layer = draft.rigArtwork?.image?.layers?.layers.find(
    (part) => part.plane === "face" || /face and neck/i.test(part.name),
  );
  if (!layer || target !== "body")
    throw new PersonaError("invalid", "얼굴·목 레이어가 있는 기본 몸을 먼저 준비하세요.");
  return { face: { kind: kind.value, sourceLayerImageUrl: layer.imageUrl } };
}

export function capturePortraitInput(
  draft: Draft,
  form: FormData,
  intent: ReturnType<typeof readIntent>,
  key: string,
  selection?: ImageModelSelection,
) {
  const count = readImageCount(
    form,
    intent === "regenerate" || isExclusiveImageIntent(intent) ? 1 : 6,
  );
  const prompts = readImagePrompts(form, count * (intent === "sheets" ? 2 : 1));
  const current = { ...draft, imagePrompts: prompts };
  if (intent === "rig-artwork") {
    const target = artworkTarget(form.get("rigArtworkTarget"));
    if (target === "outfit") requireRigBody(draft.rigArtwork?.image);
    if (!selection || selection.id !== form.get("rigArtworkModel"))
      throw new PersonaError(
        "invalid",
        "모델 카탈로그에서 원화 모델을 선택하고 정보를 확인하세요.",
      );
    const artwork = { ...draft.rigArtwork };
    delete artwork.face;
    return {
      ...current,
      rigArtwork: {
        ...artwork,
        model: selection.id,
        selection,
        target,
        ...captureFaceAction(draft, form, target),
      },
      imageCount: 1,
      portraitInstructions: readPortraitInstructions(form),
      portraitOperation: key,
      imageEditing: true,
    };
  }
  if (intent === "regenerate" || intent === "generate")
    return {
      ...current,
      imageInstructions: readPortraitInstructions(form),
      imageDirection: readImageDirection(form),
      imageCount: count,
      imageEditing: true,
      portraitOperation: intent === "regenerate" ? `regenerate:${key}` : key,
    };
  const next = {
    ...current,
    portraitInstructions: readPortraitInstructions(form),
    portraitOperation: key,
    imageCount: count,
  };
  delete next.imageInstructions;
  delete next.imageEditing;
  return next;
}

export const imagePromptOf = (draft: Draft) =>
  draft.imageInstructions ?? draft.portraitInstructions;

export const retryImageInput = (draft: Draft, failed: boolean) =>
  failed
    ? {
        portraitInstructions: imagePromptOf(draft),
        portraitOperation: draft.portraitOperation,
        imageCount: draft.imageCount,
        imagePrompts: draft.imagePrompts,
      }
    : {};

function readImageDirection(form: FormData) {
  const value = form.get("imageDirection") ?? "";
  if (typeof value !== "string" || value.length > 4000)
    throw new PersonaError("invalid", copy.formError);
  return value.trim();
}
