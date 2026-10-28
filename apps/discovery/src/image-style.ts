import type { PublicPersona } from "@ren-ai/onboarding";
import { thumbnailUrl } from "@ren-ai/personas/image-url";

export type ImageStyle = "anime" | "photo";
export type StyledPersona = PublicPersona & {
  readonly imageUrls?: readonly string[];
  readonly imageStyle?: ImageStyle;
};
const key = "ren-ai.discovery.image-style";

export function readImageStyle(): ImageStyle {
  try {
    const value = localStorage.getItem(key);
    if (value === "anime" || value === "photo") return value;
  } catch {
    // The first visit and browsers without storage start with anime.
  }
  return "anime";
}

export function saveImageStyle(style: ImageStyle): boolean {
  try {
    localStorage.setItem(key, style);
    return true;
  } catch {
    return false;
  }
}

/** The same-style gallery photos in order, as the original URLs that previews read from R2. */
export function stylePhotos(persona: PublicPersona, style: ImageStyle) {
  const legacyUrls = persona.portraitGallery?.map((pair) => pair[style]);
  const imageUrls =
    persona.secondaryPortraits !== undefined || (!legacyUrls && persona.portraits !== undefined)
      ? [
          persona.portraits?.[style],
          ...(persona.secondaryPortraits
            ?.filter((image) => image.style === style)
            .map((image) => image.imageUrl) ?? []),
        ].filter((url): url is string => Boolean(url))
      : legacyUrls;
  return {
    imageUrl:
      imageUrls === undefined
        ? (persona.portraits?.[style] ?? persona.imageUrl)
        : (imageUrls[0] ?? ""),
    ...(imageUrls && { imageUrls: imageUrls.length ? imageUrls : [""] }),
  };
}

/** Browsing shows each photo's stored display rendition rather than its multi-megabyte original. */
export function withImageStyle(persona: PublicPersona, style: ImageStyle): StyledPersona {
  const { imageUrl, imageUrls } = stylePhotos(persona, style);
  return {
    ...persona,
    imageStyle: style,
    imageUrl: thumbnailUrl(imageUrl),
    ...(imageUrls && { imageUrls: imageUrls.map(thumbnailUrl) }),
  };
}
