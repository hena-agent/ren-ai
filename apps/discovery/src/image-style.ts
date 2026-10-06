import type { PublicPersona } from "@ren-ai/onboarding";

export type ImageStyle = "anime" | "photo";
export type StyledPersona = PublicPersona & { readonly imageUrls?: readonly string[] };
const key = "ren-ai.discovery.image-style";

export function readImageStyle(): ImageStyle | undefined {
  try {
    const value = localStorage.getItem(key);
    if (value === "anime" || value === "photo") return value;
  } catch {
    // Browser storage may be unavailable; leave the style unset.
  }
  return undefined;
}

export function saveImageStyle(style: ImageStyle): boolean {
  try {
    localStorage.setItem(key, style);
    return true;
  } catch {
    return false;
  }
}

export function withImageStyle(persona: PublicPersona, style: ImageStyle): StyledPersona {
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
    ...persona,
    imageUrl:
      imageUrls === undefined
        ? (persona.portraits?.[style] ?? persona.imageUrl)
        : (imageUrls[0] ?? ""),
    ...(imageUrls && { imageUrls: imageUrls.length ? imageUrls : [""] }),
  };
}
