import type { createPersonaStore, PersonaRecord, Portrait } from "@ren-ai/personas";
import type { ProfileGenerator } from "./generation.ts";
import { characterOf } from "./authoring.ts";
import { operation } from "./logging.ts";

export type ImageStage = "generating" | "saving";

export async function generateImage(
  persona: PersonaRecord,
  style: "anime" | "photo",
  generator: ProfileGenerator,
  store: Awaited<ReturnType<typeof createPersonaStore>>,
  instructions?: string,
  reference?: Portrait,
  position?: number,
  stage?: (stage: ImageStage) => void,
) {
  const fields = { style, ...(position !== undefined && { poseIndex: position }) };
  stage?.("generating");
  const image = await operation("portrait.generate", fields, () => {
    const character = characterOf(persona);
    if (reference) return generator.portrait(character, style, instructions, reference);
    if (instructions) return generator.portrait(character, style, instructions);
    return generator.portrait(character, style);
  });
  stage?.("saving");
  return operation("image.save", fields, () => store.saveImage(image));
}

export function photoVariation(position: number) {
  const capture = [
    "A casual selfie the person would willingly post, with relaxed eye contact and a natural expression.",
    "A wider, full-body travel or outdoor photo taken by a friend, showing the occasion and a relaxed natural pose.",
    "A friend-taken everyday snapshot in a café or favorite neighborhood; the person is comfortably engaged in the moment.",
    "A hobby or social outing picture, with personal taste and natural movement rather than a directed studio pose.",
    "A distinct everyday memory the person would enjoy sharing; choose a new camera distance, expression and outfit.",
  ];
  return capture[position % capture.length]!;
}
