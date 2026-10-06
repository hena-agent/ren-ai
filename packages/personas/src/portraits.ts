import type { PersonaRecord } from "./model.ts";

export interface PersonaImage {
  readonly style: "anime" | "photo";
  readonly imageUrl: string;
}

export function normalizePortraits(persona: PersonaRecord): PersonaRecord {
  if (!persona.portraitGallery) return persona;
  const next = {
    ...persona,
    portraits: persona.portraitGallery[0]!,
    secondaryPortraits:
      persona.secondaryPortraits ??
      persona.portraitGallery
        .slice(1)
        .flatMap((pair) =>
          (["anime", "photo"] as const).map((style) => ({ style, imageUrl: pair[style] })),
        ),
  };
  delete next.portraitGallery;
  return next;
}

export function personaImages(
  input: PersonaRecord,
): readonly (PersonaImage & { readonly main: boolean })[] {
  const persona = normalizePortraits(input);
  const portraits = persona.portraits ?? (persona.imageUrl ? { photo: persona.imageUrl } : {});
  return [
    ...(["anime", "photo"] as const).flatMap((style) =>
      portraits[style] ? [{ style, imageUrl: portraits[style], main: true }] : [],
    ),
    ...(persona.secondaryPortraits ?? []).map((image) => ({ ...image, main: false })),
  ];
}
