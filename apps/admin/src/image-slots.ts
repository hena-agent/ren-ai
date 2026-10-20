export type PortraitStyle = "anime" | "photo";
export type ImageIntent = "generate" | "regenerate" | "sheet" | "sheets";
export const isSheetIntent = (intent: string) => intent === "sheet" || intent === "sheets";
export const isImageIntent = (intent: string): intent is ImageIntent =>
  ["generate", "regenerate", "sheet", "sheets"].includes(intent);
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
