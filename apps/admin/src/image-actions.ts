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
  if (intent === "subportrait")
    return {
      key: `subportrait:${params.get("style")}`,
      draft: latest?.base === draft.base ? latest : draft,
    };
  return { key: intent, draft };
}

export function capturePortraitInput(
  draft: Draft,
  form: FormData,
  intent: ReturnType<typeof readIntent>,
  key: string,
) {
  const count = readImageCount(form, intent === "regenerate" ? 1 : 6);
  const prompts = readImagePrompts(
    form,
    count * (intent === "generate" || intent === "portrait" ? 2 : 1),
  );
  const current = { ...draft, imagePrompts: prompts };
  if (intent === "regenerate" || intent === "subportrait")
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
