import {
  decodePersona,
  PersonaError,
  personaImages,
  serializePersona,
  withPersonaImages,
} from "@ren-ai/personas";
import type { PersonaStore, PersonaRecord, Portrait } from "@ren-ai/personas";
import { ownedImageKey } from "@ren-ai/personas/image-url";
import { characterOf, emptyPersona } from "./authoring.ts";
import type { Draft } from "./draft.ts";
import { completedImageDraft, previewOf } from "./draft.ts";
import type { ProfileGenerator } from "./generation.ts";
import { generateImage } from "./image-generation.ts";
import type { ImageStage } from "./image-generation.ts";
import { imageSlots, isSheetIntent } from "./image-slots.ts";
import type { ImageSlot, ImageIntent } from "./image-slots.ts";
import { imageStyle, imageTarget, readPortraitReference } from "./portrait-images.ts";
import { imagePrompt } from "./image-prompts.ts";
import { regeneratePortrait } from "./regenerate-portrait.ts";
import copy from "./copy.json";
import { assertSnapshot } from "./snapshot.ts";
import { operation } from "./logging.ts";
import { randomUUID } from "node:crypto";
import {
  assertSheets,
  generateSheet,
  sheetSource,
  requireSheetReferences,
} from "./identity-sheets.ts";

type Store = PersonaStore;
export interface ImageBatchSnapshot {
  operationId: string;
  source: PersonaRecord;
  original: Draft;
  intent: ImageIntent;
  params: string;
  key: string;
  current: PersonaRecord;
  latest: Draft;
  prompts: readonly string[];
  expectedBase: string;
}
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
    stage: (stage: ImageStage) => void | Promise<void>,
  ) => Promise<string>;
  readonly setPrompt: (ordinal: number, prompt: string) => void;
  readonly finish: (failed: boolean) => Draft;
  readonly resume: (latest: Draft, ordinals: readonly number[]) => void;
  readonly snapshot: () => ImageBatchSnapshot;
}

function slotsOf(
  persona: PersonaRecord,
  draft: Draft,
  intent: ImageIntent,
  params: URLSearchParams,
  key: string,
) {
  if (isSheetIntent(intent)) {
    const style = intent === "sheet" ? imageStyle(params) : "anime";
    if (intent === "sheet") sheetSource(persona, style, params);
    return imageSlots(intent, 1, style);
  }
  const style = imageStyle(params);
  const images = personaImages(persona).filter((image) => image.style === style);
  if (intent === "regenerate") {
    const active = images.findIndex((image) => `${style}:${image.imageUrl}` === key);
    if (active >= 0 && !ownedImageKey(images[active]!.imageUrl))
      throw new PersonaError("invalid", copy.baseOwnedRequired);
    return active < 0 ? [] : imageSlots(intent, 1, style, active);
  }
  if (draft.imageCount! > 6 - images.length) throw new PersonaError("invalid", copy.galleryFull);
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
  restored?: ImageBatchSnapshot,
): ImageBatch {
  persona = decodePersona(persona);
  const sheets = isSheetIntent(intent);
  const operationId = restored ? restored.operationId : randomUUID();
  const slots = slotsOf(persona, draft, intent, params, key);
  if (!sheets) requireSheetReferences(draft, slots);
  const prompts = restored
    ? [...restored.prompts]
    : slots.map((slot, ordinal) => imagePrompt(draft, slot, ordinal, sheets));
  let current = restored?.current ?? persona;
  let latest = restored?.latest ?? draft;
  let expectedBase = restored?.expectedBase ?? draft.base;
  const references = new Map<string, Portrait>();
  const reference = async (style: ImageSlot["style"], url: string) => {
    const cached = references.get(url);
    if (cached) return cached;
    const image = await readPortraitReference(url, style, store);
    references.set(url, image);
    return image;
  };
  const prepare = async () => {
    await assertSnapshot(store, { ...latest, base: expectedBase });
    if (sheets)
      for (const slot of slots) {
        const recovered = await operation("identity.sheet.receipt", { style: slot.style }, () =>
          store.sheetResult(persona.id, slot.style, `${operationId}:${slot.style}`),
        );
        if (recovered)
          latest = {
            ...latest,
            sheets: { ...latest.sheets, [slot.style]: recovered },
            imageEditing: true,
          };
      }
    await assertSheets(store, latest, slots);
    if (slots.length) latest = { ...latest, preview: serializePersona(current) };
  };
  const run = async (ordinal: number, stage: (stage: ImageStage) => void | Promise<void>) => {
    const slot = slots[ordinal]!;
    if (sheets) {
      latest = await generateSheet(
        current,
        latest,
        slot.style,
        prompts[ordinal]!,
        intent === "sheet" ? sheetSource(current, slot.style, params) : undefined,
        generator,
        store,
        stage,
        `${operationId}:${slot.style}`,
      );
      return latest.sheets![slot.style]!;
    }
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
    const identity = await reference(slot.style, latest.sheets![slot.style]!);
    const imageUrl = await generateImage(
      current,
      slot.style,
      generator,
      store,
      prompts[ordinal],
      identity,
      personaImages(current).filter((image) => image.style === slot.style).length,
      stage,
    );
    current = decodePersona(
      withPersonaImages(current, [...personaImages(current), { style: slot.style, imageUrl }]),
    );
    latest = { ...latest, preview: serializePersona(current), imageEditing: true };
    return imageUrl;
  };
  return {
    intent,
    personaId: persona.id,
    get source() {
      return persona;
    },
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
    snapshot: () => ({
      operationId,
      source: persona,
      original: draft,
      intent,
      params: params.toString(),
      key,
      current,
      latest,
      prompts,
      expectedBase,
    }),
    resume: (editing, ordinals) => {
      if (editing.preview !== latest.preview) {
        const next = previewOf(editing, emptyPersona);
        if (JSON.stringify(characterOf(next)) !== JSON.stringify(characterOf(persona)))
          throw new PersonaError("conflict", copy.stale);
        current = next;
      }
      const selected = ordinals.map((ordinal) => slots[ordinal]!);
      if (selected.some(({ style }) => latest.sheets?.[style] !== editing.sheets?.[style]))
        throw new PersonaError("conflict", "인물 시트가 변경되었습니다. 다시 열어 주세요.");
      const images = personaImages(current);
      if (
        intent === "regenerate" &&
        !images.some((image) => `${image.style}:${image.imageUrl}` === key)
      )
        throw new PersonaError("conflict", copy.stale);
      if (intent !== "regenerate" && !sheets)
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
        ...(editing.initial && { initial: editing.initial }),
        ...(editing.sheets && { sheets: editing.sheets }),
      };
    },
  };
}

export function restoreImageBatch(
  snapshot: ImageBatchSnapshot,
  generator: ProfileGenerator,
  store: Store,
) {
  if (typeof snapshot.operationId !== "string")
    throw new PersonaError("invalid", "이미지 작업의 생성 식별자가 없습니다.");
  if (!["generate", "regenerate", "sheet", "sheets"].includes(snapshot.intent))
    throw new PersonaError("invalid", "지원하지 않는 이미지 작업입니다.");
  return createImageBatch(
    snapshot.source,
    snapshot.original,
    snapshot.intent,
    new URLSearchParams(snapshot.params),
    snapshot.key,
    generator,
    store,
    snapshot,
  );
}
