import { decodePersona, serializePersona, PersonaError, personaImages } from "@ren-ai/personas";
import type { PersonaRecord, createPersonaStore, Portrait } from "@ren-ai/personas";
import { emptyPersona, characterOf } from "./authoring.ts";
import { previewOf, completedImageDraft } from "./draft.ts";
import type { Draft } from "./draft.ts";
import type { ProfileGenerator } from "./generation.ts";
import { imageTarget, mainImage, readPortraitReference } from "./portrait-images.ts";
import { operation } from "./logging.ts";
import copy from "./copy.json";
import type { ImageStage } from "./image-generation.ts";

export function latestImageDraft(draft: Draft, latest: Draft | undefined, params: URLSearchParams) {
  if (!latest || latest.base !== draft.base) return draft;
  const original = previewOf(draft, emptyPersona);
  const current = previewOf(latest, emptyPersona);
  const target = imageTarget(original, params);
  if (target.index > 0 && mainImage(original, target.style) !== mainImage(current, target.style))
    throw new PersonaError("conflict", copy.stale);
  return latest;
}

export const regenerationKey = (persona: PersonaRecord, params: URLSearchParams) => {
  const target = imageTarget(persona, params);
  return `${target.style}:${target.url}`;
};

export async function regeneratePortrait(
  persona: PersonaRecord,
  draft: Draft,
  params: URLSearchParams,
  submittedKey: string,
  generator: ProfileGenerator,
  store: Awaited<ReturnType<typeof createPersonaStore>>,
  stage: (stage: ImageStage) => void,
) {
  const active = personaImages(persona).find(
    (image) => `${image.style}:${image.imageUrl}` === submittedKey,
  )!;
  const target = imageTarget(
    persona,
    new URLSearchParams({ image: active.imageUrl, style: active.style }),
  );
  const fields = { style: target.style, poseIndex: target.index };
  let reference: Portrait | undefined;
  let composition: Portrait | undefined;
  if (!active.main) {
    reference = await readPortraitReference(mainImage(persona, target.style)!, target.style, store);
    composition = await readPortraitReference(target.url, target.style, store);
  }
  stage("generating");
  const image = await operation("portrait.generate", fields, () =>
    generator.portrait(
      characterOf(persona),
      target.style,
      draft.imageInstructions,
      reference,
      composition,
    ),
  );
  stage("saving");
  const imageUrl = await operation("image.save", fields, () => store.saveImage(image));
  const record = decodePersona({
    ...persona,
    imageUrl:
      active.main && (target.style === "photo" || !mainImage(persona, "photo"))
        ? imageUrl
        : persona.imageUrl,
    ...(active.main &&
      persona.portraits && { portraits: { ...persona.portraits, [target.style]: imageUrl } }),
    ...(persona.secondaryPortraits && {
      secondaryPortraits: persona.secondaryPortraits.map((entry) =>
        entry.style === target.style && entry.imageUrl === target.url
          ? { ...entry, imageUrl }
          : entry,
      ),
    }),
  });
  return completedImageDraft({ ...draft, preview: serializePersona(record) });
}

export function deletePortrait(persona: PersonaRecord, draft: Draft, submittedKey: string) {
  if (!personaImages(persona).some((image) => `${image.style}:${image.imageUrl}` === submittedKey))
    return draft;
  const remaining = personaImages(persona).filter(
    (image) => `${image.style}:${image.imageUrl}` !== submittedKey,
  );
  const primary = (["anime", "photo"] as const).map((style) =>
    remaining.find((image) => image.style === style),
  );
  const portraits = {
    ...(primary[0] && { anime: primary[0].imageUrl }),
    ...(primary[1] && { photo: primary[1].imageUrl }),
  };
  const secondaryPortraits = remaining
    .filter((image) => !primary.includes(image))
    .map(({ style, imageUrl }) => ({ style, imageUrl }));
  const next = {
    ...persona,
    secondaryPortraits,
    imageUrl: primary[1]?.imageUrl ?? primary[0]?.imageUrl ?? "",
    published: persona.published && remaining.length > 0,
  };
  delete next.portraits;
  if (remaining.length > 0) next.portraits = portraits;
  return completedImageDraft({ ...draft, preview: serializePersona(decodePersona(next)) });
}
