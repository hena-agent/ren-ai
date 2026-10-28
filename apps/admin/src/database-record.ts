import { readProjection } from "@ren-ai/personas";
import type { PersonaRecord } from "@ren-ai/personas";
import { personas, personaImages, personaVersions } from "./database-schema.ts";
import { getTableColumns, and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { protect } from "./logging.ts";
import { personaImageBase } from "@ren-ai/personas/image-url";

export const currentPersonaRows = (db: DrizzleD1Database) =>
  db
    .select({ ...getTableColumns(personas), markdown: personaVersions.markdown })
    .from(personas)
    .innerJoin(
      personaVersions,
      and(
        eq(personaVersions.personaId, personas.id),
        eq(personaVersions.version, personas.currentVersion),
      ),
    );

type PersonaRow = typeof personas.$inferSelect & { markdown: string };

/** A stored row's document fields, as every Persona record carries them. */
export const documentFields = (row: PersonaRow) => ({
  id: row.id,
  name: row.name,
  published: row.published,
  timeZone: row.timeZone,
  language: row.language,
  openingLine: row.openingLine,
  memory: row.memoryInstruction,
  prompt: row.markdown,
  description: row.markdown,
});

/** Rows were validated when saved, and their projection holds every Markdown-derived value. */
export function recordOf(
  row: PersonaRow,
  photos: readonly (typeof personaImages.$inferSelect)[],
  imageBase = personaImageBase,
): PersonaRecord & { readonly version: number; readonly description: string } {
  protect(row.markdown, row.state, row.memory, row.memoryInstruction, row.openingLine);
  const portraits = Object.fromEntries(
    photos
      .filter((photo) => photo.position === 0)
      .map((photo) => [photo.style, `${imageBase}${photo.objectKey}`]),
  );
  const { bio, publicProfile } = readProjection(row.projection);
  return {
    ...documentFields(row),
    version: row.currentVersion,
    bio,
    publicProfile,
    imageUrl: portraits["photo"] ?? portraits["anime"] ?? "",
    ...(row.gender && { gender: row.gender }),
    ...(row.descriptionVersion !== null && { descriptionVersion: row.descriptionVersion }),
    ...(photos.length && { portraits }),
    secondaryPortraits: photos
      .filter((photo) => photo.position > 0)
      .map((photo) => ({ style: photo.style, imageUrl: `${imageBase}${photo.objectKey}` })),
  };
}
