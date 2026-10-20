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

export function personaImages(input: PersonaRecord): readonly PersonaImage[] {
  const persona = normalizePortraits(input);
  const portraits = persona.portraits ?? (persona.imageUrl ? { photo: persona.imageUrl } : {});
  return [
    ...(["anime", "photo"] as const).flatMap((style) =>
      portraits[style] ? [{ style, imageUrl: portraits[style] }] : [],
    ),
    ...(persona.secondaryPortraits ?? []),
  ];
}

/** Project gallery order onto the persisted/public photo fields. No photo has an identity role. */
export function withPersonaImages(
  persona: PersonaRecord,
  images: readonly PersonaImage[],
): PersonaRecord {
  const first = (style: PersonaImage["style"]) => images.find((image) => image.style === style);
  const anime = first("anime");
  const photo = first("photo");
  const next = {
    ...persona,
    imageUrl: photo?.imageUrl ?? anime?.imageUrl ?? "",
    secondaryPortraits: images
      .filter((image) => image !== anime && image !== photo)
      .map(({ style, imageUrl }) => ({ style, imageUrl })),
    published: persona.published && images.length > 0,
  };
  delete next.portraits;
  delete next.portraitGallery;
  if (images.length)
    next.portraits = {
      ...(anime && { anime: anime.imageUrl }),
      ...(photo && { photo: photo.imageUrl }),
    };
  return next;
}
