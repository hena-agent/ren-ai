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
import { isSheetIntent } from "./image-slots.ts";
import { imageStyle } from "./portrait-images.ts";

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
  if (intent === "generate" || isSheetIntent(intent))
    return {
      key:
        intent === "sheets"
          ? "sheets"
          : intent === "sheet"
            ? `sheet:${imageStyle(params)}:${params.get("image") ?? draft.sheets?.[imageStyle(params)] ?? "new"}`
            : `generate:${imageStyle(params)}`,
      draft: adoptPhotos(draft, latest),
    };
  return { key: intent, draft };
}

export function capturePortraitInput(
  draft: Draft,
  form: FormData,
  intent: ReturnType<typeof readIntent>,
  key: string,
) {
  const count = readImageCount(form, intent === "regenerate" || isSheetIntent(intent) ? 1 : 6);
  const prompts = readImagePrompts(form, count * (intent === "sheets" ? 2 : 1));
  const current = { ...draft, imagePrompts: prompts };
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
