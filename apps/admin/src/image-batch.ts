import { decodePersona, PersonaError, personaImages, serializePersona } from "@ren-ai/personas";
import type { createPersonaStore, PersonaRecord, Portrait } from "@ren-ai/personas";
import {
  characterOf,
  emptyPersona,
  needsIntroduction,
  requireMatchingProfile,
} from "./authoring.ts";
import type { Draft } from "./draft.ts";
import { completedImageDraft, previewOf } from "./draft.ts";
import type { ProfileGenerator } from "./generation.ts";
import { generateImage } from "./image-generation.ts";
import type { ImageStage } from "./image-generation.ts";
import { imageSlots } from "./image-slots.ts";
import type { ImageSlot, ImageIntent } from "./image-slots.ts";
import { imageStyle, imageTarget, mainImage, readPortraitReference } from "./portrait-images.ts";
import { imagePrompt } from "./image-prompts.ts";
import { regeneratePortrait } from "./regenerate-portrait.ts";
import { operation } from "./logging.ts";
import copy from "./copy.json";

type Store = Awaited<ReturnType<typeof createPersonaStore>>;
export interface ImageBatch {
  readonly intent: ImageIntent;
  readonly personaId: string;
  readonly source: PersonaRecord;
  readonly slots: readonly ImageSlot[];
  readonly prompts: readonly string[];
  readonly draft: () => Draft;
  readonly record: () => PersonaRecord;
  readonly prepare: () => Promise<void>;
  readonly run: (
    ordinal: number,
    stage: (stage: ImageStage) => void,
  ) => Promise<string | undefined>;
  readonly setPrompt: (ordinal: number, prompt: string) => void;
  readonly finish: (failed: boolean) => Draft;
  readonly resume: (latest: Draft, ordinals: readonly number[]) => void;
}

function appendImage(record: PersonaRecord, slot: ImageSlot, imageUrl: string) {
  if (mainImage(record, slot.style))
    return decodePersona({
      ...record,
      secondaryPortraits: [...(record.secondaryPortraits ?? []), { style: slot.style, imageUrl }],
    });
  const portraits = {
    ...(record.portraits ?? (record.imageUrl ? { photo: record.imageUrl } : {})),
    [slot.style]: imageUrl,
  };
  return decodePersona({ ...record, portraits, imageUrl: portraits.photo ?? portraits.anime! });
}

function slotsOf(
  persona: PersonaRecord,
  draft: Draft,
  intent: ImageIntent,
  params: URLSearchParams,
  key: string,
) {
  if (intent === "generate" || intent === "portrait") return imageSlots(intent, draft.imageCount!);
  const style = imageStyle(params);
  const images = personaImages(persona).filter((image) => image.style === style);
  if (intent === "regenerate") {
    const active = images.findIndex((image) => `${style}:${image.imageUrl}` === key);
    if (
      active > 0 &&
      [mainImage(persona, style)!, images[active]!.imageUrl].some(
        (url) => !url.startsWith("/discovery/images/"),
      )
    )
      throw new PersonaError("invalid", copy.baseOwnedRequired);
    return active < 0 ? [] : imageSlots(intent, 1, style, active);
  }
  if (draft.imageCount! > 6 - images.length) throw new PersonaError("invalid", copy.galleryFull);
  const main = mainImage(persona, style);
  if (main && !main.startsWith("/discovery/images/"))
    throw new PersonaError("invalid", copy.baseOwnedRequired);
  return imageSlots(intent, draft.imageCount!, style, images.length);
}

export function createImageBatch(
  persona: PersonaRecord,
  draft: Draft,
  intent: ImageIntent,
  params: URLSearchParams,
  key: string,
  generator: ProfileGenerator,
  store: Store,
): ImageBatch {
  const initial = intent === "generate" || intent === "portrait";
  if (intent !== "generate") {
    if (!persona.bio) throw new PersonaError("invalid", copy.regenerateRequired);
    requireMatchingProfile(persona, previewOf(draft, emptyPersona));
  }
  const slots = slotsOf(persona, draft, intent, params, key);
  const prompts = slots.map((slot, ordinal) => imagePrompt(draft, slot, ordinal, initial));
  let current = persona;
  let latest = draft;
  let expectedBase = draft.base;
  let prepared = false;
  const references = new Map<string, Portrait>();
  const reference = async (style: ImageSlot["style"], url: string) => {
    const cached = references.get(url);
    if (cached) return cached;
    const image = await readPortraitReference(url, style, store);
    references.set(url, image);
    return image;
  };
  const prepare = async () => {
    if (expectedBase && serializePersona(await store.get(draft.id)) !== expectedBase)
      throw new PersonaError("conflict", copy.stale);
    if (prepared || !initial) return;
    const bio =
      intent === "generate" && needsIntroduction(persona, previewOf(draft, emptyPersona))
        ? await operation("introduction.generate", {}, () =>
            generator.introduction(characterOf(persona)),
          )
        : persona.bio;
    const fresh = { ...persona, bio, imageUrl: "" };
    delete fresh.portraits;
    delete fresh.secondaryPortraits;
    delete fresh.portraitGallery;
    current = fresh;
    prepared = true;
  };
  const run = async (ordinal: number, stage: (stage: ImageStage) => void) => {
    const slot = slots[ordinal]!;
    if (intent === "regenerate") {
      const target = imageTarget(current, params);
      const next = await regeneratePortrait(
        current,
        { ...latest, imageInstructions: prompts[ordinal]! },
        params,
        key,
        generator,
        store,
        stage,
      );
      current = previewOf(next, emptyPersona);
      latest = { ...latest, preview: next.preview };
      return personaImages(current).filter((image) => image.style === slot.style)[target.index]!
        .imageUrl;
    }
    const main = mainImage(current, slot.style);
    if (initial && slot.index > 0 && !main) return undefined;
    const identity = main ? await reference(slot.style, main) : undefined;
    const imageUrl = await generateImage(
      current,
      slot.style,
      generator,
      store,
      prompts[ordinal],
      identity,
      intent === "subportrait"
        ? personaImages(current).filter((image) => image.style === slot.style).length
        : slot.index,
      stage,
    );
    current = appendImage(current, slot, imageUrl);
    latest = { ...latest, preview: serializePersona(current), imageEditing: true };
    return imageUrl;
  };
  return {
    intent,
    personaId: persona.id,
    source: persona,
    slots,
    prompts,
    draft: () => latest,
    record: () => (latest.preview === draft.preview ? persona : previewOf(latest, emptyPersona)),
    prepare,
    run,
    setPrompt: (ordinal, prompt) => {
      prompts[ordinal] = prompt;
      latest = { ...latest, imagePrompts: [...prompts] };
    },
    finish: (failed) => {
      latest = failed ? latest : completedImageDraft(latest);
      return latest;
    },
    resume: (editing, ordinals) => {
      if (editing.preview !== latest.preview) {
        const next = previewOf(editing, emptyPersona);
        if (JSON.stringify(characterOf(next)) !== JSON.stringify(characterOf(persona)))
          throw new PersonaError("conflict", copy.stale);
        current = next;
      }
      const selected = ordinals.map((ordinal) => slots[ordinal]!);
      const images = personaImages(current);
      if (
        intent === "regenerate" &&
        !images.some((image) => `${image.style}:${image.imageUrl}` === key)
      )
        throw new PersonaError("conflict", copy.stale);
      if (intent !== "regenerate")
        for (const style of ["anime", "photo"] as const)
          if (
            images.filter((image) => image.style === style).length +
              selected.filter((slot) => slot.style === style).length >
            6
          )
            throw new PersonaError("invalid", copy.galleryFull);
      expectedBase = editing.base;
      latest = {
        ...latest,
        base: editing.base,
        preview: editing.preview,
      };
    },
  };
}
