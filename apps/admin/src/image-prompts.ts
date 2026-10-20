import { PersonaError } from "@ren-ai/personas";
import type { Draft } from "./draft.ts";
import type { ImageSlot } from "./image-slots.ts";
import { photoVariation } from "./image-generation.ts";
import copy from "./copy.json";

export function readImagePrompts(form: FormData, total: number) {
  if (form.get("separateImagePrompts") !== "1") return [];
  const values = [form.get("portraitInstructions"), ...form.getAll("imagePrompts")];
  if (values.length !== total) throw new PersonaError("invalid", copy.formError);
  return values.map((value) => {
    if (typeof value !== "string" || value.length > 4000)
      throw new PersonaError("invalid", copy.formError);
    return value.trim();
  });
}

export function imagePrompt(draft: Draft, slot: ImageSlot, ordinal: number, sheet: boolean) {
  if (draft.imagePrompts?.length) {
    const prompt = draft.imagePrompts[ordinal]!;
    return prompt || (!sheet && draft.imageCount! > 1 ? photoVariation(slot.index) : "");
  }
  const direction = sheet
    ? draft.portraitInstructions!
    : [draft.imageDirection, draft.imageInstructions]
        .filter(Boolean)
        .join("\n\nOPERATOR DIRECTION:\n");
  if (sheet || draft.imageCount === 1) return direction;
  return [direction, photoVariation(slot.index)].filter(Boolean).join("\n\nPHOTO DIRECTION:\n");
}
