export type PortraitStyle = "anime" | "photo";
export type ImageIntent = "generate" | "portrait" | "subportrait" | "regenerate";
export const isImageIntent = (intent: string): intent is ImageIntent =>
  ["generate", "portrait", "subportrait", "regenerate"].includes(intent);
export interface ImageSlot {
  readonly style: PortraitStyle;
  readonly index: number;
}

export function imageSlots(
  intent: string,
  count: number,
  style: PortraitStyle = "photo",
  offset = 0,
): readonly ImageSlot[] {
  if (intent !== "generate" && intent !== "portrait")
    return Array.from({ length: count }, (_, index) => ({ style, index: offset + index }));
  const mains: ImageSlot[] = [
    { style: "anime", index: 0 },
    { style: "photo", index: 0 },
  ];
  return [
    ...mains,
    ...(["anime", "photo"] as const).flatMap((rendering) =>
      Array.from({ length: count - 1 }, (_, index) => ({ style: rendering, index: index + 1 })),
    ),
  ];
}
