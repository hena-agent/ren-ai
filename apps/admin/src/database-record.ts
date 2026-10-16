import { decodePersona } from "@ren-ai/personas";
import { personas, personaImages, personaVersions } from "./database-schema.ts";
import { getTableColumns, and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { protect } from "./logging.ts";

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

export function recordOf(
  row: typeof personas.$inferSelect & { markdown: string },
  photos: readonly (typeof personaImages.$inferSelect)[],
) {
  protect(row.markdown, row.state, row.memory, row.memoryInstruction, row.openingLine);
  const portraits = Object.fromEntries(
    photos
      .filter((photo) => photo.position === 0)
      .map((photo) => [photo.style, `/discovery/images/${photo.objectKey}`]),
  );
  const record = decodePersona({
    id: row.id,
    version: row.currentVersion,
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
  return { ...record, version: row.currentVersion, description: row.markdown };
}
