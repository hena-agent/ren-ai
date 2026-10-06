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

export function imagePrompt(draft: Draft, slot: ImageSlot, ordinal: number, initial: boolean) {
  const variation = initial ? Math.max(0, slot.index - 1) : slot.index;
  if (draft.imagePrompts?.length) {
    const prompt = draft.imagePrompts[ordinal]!;
    return prompt || (slot.index > 0 && draft.imageCount! > 1 ? photoVariation(variation) : "");
  }
  const direction = initial
    ? draft.portraitInstructions!
    : [draft.imageDirection, draft.imageInstructions]
        .filter(Boolean)
        .join("\n\nOPERATOR DIRECTION:\n");
  if ((initial && slot.index === 0) || (!initial && draft.imageCount === 1)) return direction;
  return [direction, photoVariation(variation)].filter(Boolean).join("\n\nPHOTO DIRECTION:\n");
}
