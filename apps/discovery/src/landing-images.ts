import type { ImageStyle } from "./image-style.ts";

export const landingPersonas = [
  { image: "seoyeon", name: "한서연" },
  { image: "dohee", name: "백도희" },
  { image: "seoyul", name: "강서율" },
];

export function landingImage(name: string, style: ImageStyle): string {
  return `/landing/${name}${style === "anime" ? "-anime" : ""}.webp`;
}

export function landingImages(style: ImageStyle): readonly string[] {
  return [...landingPersonas.map((persona) => persona.image), "dohee-daily"].map((name) =>
    landingImage(name, style),
  );
}
