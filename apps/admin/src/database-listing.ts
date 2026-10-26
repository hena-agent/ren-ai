import { and, asc, count, desc, eq, exists, inArray, notExists, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { personaPage, personaPageSize, type PersonaQuery } from "@ren-ai/personas";
import { personas, personaImages } from "./database-schema.ts";
import { currentPersonaRows, recordOf } from "./database-record.ts";

export async function databaseListing(
  db: DrizzleD1Database,
  imageBase: string,
  query: PersonaQuery,
) {
  const photos = db
    .select({ id: personaImages.personaId })
    .from(personaImages)
    .where(
      and(
        eq(personaImages.personaId, personas.id),
        query.style === "photo" || query.style === "anime"
          ? eq(personaImages.style, query.style)
          : undefined,
      ),
    );
  const term = `%${query.q.replace(/[\\%_]/g, "\\$&")}%`;
  const where = and(
    query.q
      ? or(
          sql`${personas.name} LIKE ${term} ESCAPE '\\'`,
          sql`${personas.id} LIKE ${term} ESCAPE '\\'`,
        )
      : undefined,
    query.published === "all" ? undefined : eq(personas.published, query.published === "published"),
    query.language ? eq(personas.language, query.language) : undefined,
    query.style === "all" ? undefined : query.style === "none" ? notExists(photos) : exists(photos),
  );
  const order =
    query.sort === "updated"
      ? desc(personas.updatedAt)
      : query.sort === "oldest"
        ? asc(personas.createdAt)
        : desc(personas.createdAt);
  const pageOf = (number: number) => {
    const offset = (number - 1) * personaPageSize;
    const ids = db
      .select({ id: personas.id })
      .from(personas)
      .where(where)
      .orderBy(order, desc(personas.id))
      .limit(personaPageSize)
      .offset(offset);
    return [
      currentPersonaRows(db)
        .where(where)
        .orderBy(order, desc(personas.id))
        .limit(personaPageSize)
        .offset(offset),
      db
        .select()
        .from(personaImages)
        .where(inArray(personaImages.personaId, ids))
        .orderBy(asc(personaImages.position)),
    ] as const;
  };
  // One round trip reads the requested page; only an out-of-range page needs a second.
  const [totals, languages, requestedRows, requestedImages] = await db.batch([
    db.select({ total: count() }).from(personas).where(where),
    db
      .selectDistinct({ language: personas.language })
      .from(personas)
      .orderBy(asc(personas.language)),
    ...pageOf(query.page),
  ]);
  const page = personaPage(totals[0]!.total, query.page);
  const [rows, images] =
    page.page === query.page ? [requestedRows, requestedImages] : await db.batch(pageOf(page.page));
  return {
    ...page,
    languages: languages.map(({ language }) => language),
    personas: rows.map((row) =>
      recordOf(
        row,
        images.filter((image) => image.personaId === row.id),
        imageBase,
      ),
    ),
  };
}
