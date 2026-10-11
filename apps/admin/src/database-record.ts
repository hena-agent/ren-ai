import { decodePersona } from "@ren-ai/personas";
import { personas, personaImages } from "./database-schema.ts";
import { protect } from "./logging.ts";

export function recordOf(
  row: typeof personas.$inferSelect,
  photos: readonly (typeof personaImages.$inferSelect)[],
) {
  protect(row.markdown, row.state, row.memory, row.memoryInstruction, row.openingLine);
  const portraits = Object.fromEntries(
    photos
      .filter((photo) => photo.position === 0)
      .map((photo) => [photo.style, `/discovery/images/${photo.objectKey}`]),
  );
  return decodePersona({
    id: row.id,
    name: row.name,
    published: row.published,
    timeZone: row.timeZone,
    language: row.language,
    openingLine: row.openingLine,
    memory: row.memoryInstruction,
    prompt: row.markdown,
    description: row.markdown,
    bio: "",
    imageUrl: portraits["photo"] ?? portraits["anime"] ?? "",
    ...(row.gender && { gender: row.gender }),
    ...(row.descriptionVersion !== null && { descriptionVersion: row.descriptionVersion }),
    ...(photos.length && { portraits }),
    secondaryPortraits: photos
      .filter((photo) => photo.position > 0)
      .map((photo) => ({ style: photo.style, imageUrl: `/discovery/images/${photo.objectKey}` })),
  });
}
