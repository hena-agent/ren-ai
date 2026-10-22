import type { ImageStyle } from "./image-style.ts";

export const landingPersonas = [
  { image: "seoyeon" },
  { image: "dohee" },
  { image: "seoyul" },
] as const;

export function landingImage(name: string, style: ImageStyle): string {
  return `/landing/${name}${style === "anime" ? "-anime" : ""}.webp`;
}

export function landingImages(style: ImageStyle): readonly string[] {
  return [...landingPersonas.map((persona) => persona.image), "dohee-daily"].map((name) =>
    landingImage(name, style),
  );
}
