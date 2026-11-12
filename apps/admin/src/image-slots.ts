export type PortraitStyle = "anime" | "photo";
export type ImageIntent =
  | "generate"
  | "regenerate"
  | "sheet"
  | "sheets"
  | "rig-artwork"
  | "rig-layers";
export const isArtworkIntent = (intent: string) =>
  intent === "rig-artwork" || intent === "rig-layers";
export const isSheetIntent = (intent: string) => intent === "sheet" || intent === "sheets";
export const isExclusiveImageIntent = (intent: string) =>
  isSheetIntent(intent) || isArtworkIntent(intent);
export const isImageIntent = (intent: string): intent is ImageIntent =>
  ["generate", "regenerate", "sheet", "sheets", "rig-artwork", "rig-layers"].includes(intent);
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
  if (intent === "sheets")
    return [
      { style: "anime", index: 0 },
      { style: "photo", index: 0 },
    ];
  if (intent === "sheet") return [{ style, index: 0 }];
  return Array.from({ length: count }, (_, index) => ({ style, index: offset + index }));
}
