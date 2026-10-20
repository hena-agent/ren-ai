import {
  decodePersona,
  serializePersona,
  PersonaError,
  personaImages,
  withPersonaImages,
} from "@ren-ai/personas";
import type { PersonaRecord, PersonaStore } from "@ren-ai/personas";
import { emptyPersona, characterOf } from "./authoring.ts";
import { previewOf, completedImageDraft } from "./draft.ts";
import type { Draft } from "./draft.ts";
import type { ProfileGenerator } from "./generation.ts";
import { imageTarget, readPortraitReference } from "./portrait-images.ts";
import { operation } from "./logging.ts";
import copy from "./copy.json";
import type { ImageStage } from "./image-generation.ts";

export function latestImageDraft(draft: Draft, latest: Draft | undefined, params: URLSearchParams) {
  if (!latest || latest.base !== draft.base) return draft;
  const original = previewOf(draft, emptyPersona);
  const target = imageTarget(original, params);
  if (draft.sheets?.[target.style] !== latest.sheets?.[target.style])
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
  store: PersonaStore,
  stage: (stage: ImageStage) => void | Promise<void>,
) {
  const active = personaImages(persona).find(
    (image) => `${image.style}:${image.imageUrl}` === submittedKey,
  )!;
  const target = imageTarget(
    persona,
    new URLSearchParams({ image: active.imageUrl, style: active.style }),
  );
  const fields = { style: target.style, poseIndex: target.index };
  const reference = await readPortraitReference(draft.sheets![target.style]!, target.style, store);
  const composition = await readPortraitReference(target.url, target.style, store);
  await stage("generating");
  const image = await operation("portrait.generate", fields, () =>
    generator.portrait(
      characterOf(persona),
      target.style,
      draft.imageInstructions,
      reference,
      composition,
    ),
  );
  await stage("saving");
  const imageUrl = await operation("image.save", fields, () => store.saveImage(image));
  const record = decodePersona(
    withPersonaImages(
      persona,
      personaImages(persona).map((entry) =>
        entry.style === target.style && entry.imageUrl === target.url
          ? { ...entry, imageUrl }
          : entry,
      ),
    ),
  );
  return completedImageDraft({ ...draft, preview: serializePersona(record) });
}

export function deletePortrait(persona: PersonaRecord, draft: Draft, submittedKey: string) {
  if (!personaImages(persona).some((image) => `${image.style}:${image.imageUrl}` === submittedKey))
    return draft;
  const remaining = personaImages(persona).filter(
    (image) => `${image.style}:${image.imageUrl}` !== submittedKey,
  );
  return completedImageDraft({
    ...draft,
    preview: serializePersona(decodePersona(withPersonaImages(persona, remaining))),
  });
}
