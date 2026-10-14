import type { D1Database } from "@cloudflare/workers-types";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { decodePersona, PersonaError, publicationIssues, serializePersona } from "@ren-ai/personas";
import type { PersonaStore } from "@ren-ai/personas";
import { personas, personaImages } from "./database-schema.ts";
import { r2Images } from "./r2-images.ts";
import type { ImageBucket } from "./r2-images.ts";
import { recordOf } from "./database-record.ts";
import { validationFailure } from "./logging.ts";
import { personaValues, photoValues } from "./catalog-values.ts";
import { readPublicCatalog } from "@ren-ai/personas/catalog";

async function databaseOperation<T>(run: () => Promise<T>) {
  try {
    return await run();
  } catch (cause) {
    throw validationFailure(
      "Catalog database operation failed",
      { stage: "persistence.database", code: "database_error" },
      cause,
    );
  }
}

export function databaseStore(
  binding: D1Database,
  bucket: ImageBucket,
): PersonaStore & {
  catalog: () => Promise<{
    revision: string;
    personas: readonly { id: string; source: string; state: string; memory: string }[];
  }>;
} {
  const db = drizzle(binding);
  const images = r2Images(bucket);
  const rowOf = async (id: string) => {
    const row = await db.select().from(personas).where(eq(personas.id, id)).get();
    if (!row) throw new PersonaError("not_found", "페르소나를 찾을 수 없습니다.");
    return row;
  };
  const get = async (id: string) =>
    recordOf(
      await rowOf(id),
      await db
        .select()
        .from(personaImages)
        .where(eq(personaImages.personaId, id))
        .orderBy(asc(personaImages.position)),
    );
  const readCatalog = () =>
    databaseOperation(() =>
      db.batch([
        db.select().from(personas).orderBy(asc(personas.id)),
        db.select().from(personaImages).orderBy(asc(personaImages.position)),
      ]),
    );
  const list = async () => {
    const [rows, photos] = await readCatalog();
    return rows.map((row) =>
      recordOf(
        row,
        photos.filter((photo) => photo.personaId === row.id),
      ),
    );
  };
  const source = async (id: string) => serializePersona(await get(id));
  return {
    catalog: async () => {
      const [rows, photos] = await readCatalog();
      return {
        revision: JSON.stringify(rows.map(({ id, revision }) => ({ id, revision }))),
        personas: rows.map((row) => ({
          id: row.id,
          source: serializePersona(
            recordOf(
              row,
              photos.filter((photo) => photo.personaId === row.id),
            ),
          ),
          state: row.state,
          memory: row.memory,
        })),
      };
    },
    list,
    get,
    source,
    initial: async (id) => {
      const row = await rowOf(id);
      return { state: row.state, memory: row.memory };
    },
    inspect: async () => (await list()).map((persona) => ({ id: persona.id, persona })),
    importDraft: async () => {
      throw new PersonaError("not_found", "파일 가져오기는 지원하지 않습니다.");
    },
    ...images,
    publicImage: async (filename) => {
      const referenced = await db
        .select({ id: personas.id })
        .from(personaImages)
        .innerJoin(personas, eq(personaImages.personaId, personas.id))
        .where(and(eq(personas.published, true), eq(personaImages.objectKey, filename)))
        .get();
      return referenced ? images.image(filename) : new Response(null, { status: 404 });
    },
    publicList: () => databaseOperation(() => readPublicCatalog(binding)),
    save: async (input, documents, expected) => {
      const record = decodePersona(input);
      if (record.published) {
        const issues = publicationIssues(record, documents);
        if (issues.length)
          throw new PersonaError("invalid", issues.map((issue) => issue.message).join(" "));
      }
      const previous = await db.select().from(personas).where(eq(personas.id, record.id)).get();
      if (
        (previous ? serializePersona(await get(record.id)) : "") !== expected.persona ||
        (previous &&
          JSON.stringify({ state: previous.state, memory: previous.memory }) !==
            JSON.stringify(expected.initial))
      )
        throw new PersonaError(
          "conflict",
          "Persona 또는 초기값이 변경되었습니다. 다시 열어 주세요.",
        );
      const photos = await photoValues(record, bucket);
      const values = personaValues(record, documents, previous);
      const commitId = values.commitId;
      const ownsCommit = sql`exists (select 1 from ${personas} where ${personas.id} = ${record.id} and ${personas.commitId} = ${commitId})`;
      const write = previous
        ? db
            .update(personas)
            .set(values)
            .where(and(eq(personas.id, record.id), eq(personas.revision, previous.revision)))
        : db.insert(personas).values(values).onConflictDoNothing();
      const inserts = photos.map((photo) =>
        db.insert(personaImages).select(
          db
            .select({
              personaId: sql<string>`${photo.personaId}`.as("personaId"),
              objectKey: sql<string>`${photo.objectKey}`.as("objectKey"),
              style: sql<"anime" | "photo">`${photo.style}`.as("style"),
              position: sql<number>`${photo.position}`.as("position"),
              mimeType: sql<string>`${photo.mimeType}`.as("mimeType"),
              size: sql<number>`${photo.size}`.as("size"),
            })
            .from(personas)
            .where(and(eq(personas.id, record.id), eq(personas.commitId, commitId))),
        ),
      );
      const [result] = await databaseOperation(() =>
        db.batch([
          write,
          db.delete(personaImages).where(and(eq(personaImages.personaId, record.id), ownsCommit)),
          ...inserts,
        ]),
      );
      if (!result.meta.changes)
        throw new PersonaError("conflict", "Persona가 변경되었습니다. 다시 열어 주세요.");
    },
  };
}
