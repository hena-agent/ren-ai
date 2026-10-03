import type { PublicPersona } from "@ren-ai/onboarding";

export type ImageStyle = "anime" | "photo";
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

export function withImageStyle(persona: PublicPersona, style: ImageStyle): PublicPersona {
  return { ...persona, imageUrl: persona.portraits?.[style] ?? persona.imageUrl };
}
