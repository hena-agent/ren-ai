import type { D1Database } from "@cloudflare/workers-types";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { decodePersona, projectPersona } from "@ren-ai/personas";
import { personas } from "./database-schema.ts";
import { currentPersonaRows, documentFields } from "./database-record.ts";

/**
 * Recomputes every stored projection from the current Markdown with the code being deployed, so a
 * changed derivation never leaves stale profiles. A Persona saved meanwhile keeps her own projection.
 */
export async function rebuildProjections(binding: D1Database) {
  const db = drizzle(binding);
  const rows = await currentPersonaRows(db);
  const updates = rows.flatMap((row) => {
    const record = decodePersona({ ...documentFields(row), bio: "", imageUrl: "" });
    const projection = projectPersona(record, row.state);
    return projection === row.projection
      ? []
      : [
          db
            .update(personas)
            .set({ projection, revision: row.revision + 1 })
            .where(and(eq(personas.id, row.id), eq(personas.revision, row.revision))),
        ];
  });
  for (let index = 0; index < updates.length; index += 50) {
    const [first, ...rest] = updates.slice(index, index + 50);
    await db.batch([first!, ...rest]);
  }
  return { personas: rows.length, updated: updates.length };
}
