import type { D1Database } from "@cloudflare/workers-types";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  decodePersona,
  PersonaError,
  publicationIssues,
  serializePersona,
  nextPersonaVersion,
  requireVersion,
} from "@ren-ai/personas";
import type { PersonaStore } from "@ren-ai/personas";
import { personas, personaImages, personaVersions } from "./database-schema.ts";
import { r2Images } from "./r2-images.ts";
import type { ImageBucket } from "./r2-images.ts";
import { recordOf, currentPersonaRows } from "./database-record.ts";
import { validationFailure } from "./logging.ts";
import { personaValues, photoValues } from "./catalog-values.ts";
import { readPublicCatalog } from "@ren-ai/personas/catalog";
import { personaImageBase } from "@ren-ai/personas/image-url";
import { databaseSheets } from "./database-sheets.ts";

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
  imageBase = personaImageBase,
): PersonaStore & {
  catalog: () => Promise<{
    revision: string;
    personas: readonly { id: string; source: string; state: string; memory: string }[];
  }>;
} {
  const db = drizzle(binding);
  const images = r2Images(bucket, imageBase);
  const rowOf = async (id: string) => {
    const row = await currentPersonaRows(db).where(eq(personas.id, id)).get();
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
      imageBase,
    );
  const readCatalog = () =>
    databaseOperation(() =>
      db.batch([
        currentPersonaRows(db).orderBy(asc(personas.id)),
        db.select().from(personaImages).orderBy(asc(personaImages.position)),
      ]),
    );
  const list = async () => {
    const [rows, photos] = await readCatalog();
    return rows.map((row) =>
      recordOf(
        row,
        photos.filter((photo) => photo.personaId === row.id),
        imageBase,
      ),
    );
  };
  const source = async (id: string) => serializePersona(await get(id));
  return {
    ...databaseSheets(binding, imageBase),
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
              imageBase,
            ),
          ),
          state: row.state,
          memory: row.memory,
        })),
      };
    },
    list,
    get,
    versions: async (id) => {
      await rowOf(id);
      return databaseOperation(() =>
        db
          .select({
            version: personaVersions.version,
            createdAt: personaVersions.createdAt,
            restoredFrom: personaVersions.restoredFrom,
          })
          .from(personaVersions)
          .where(eq(personaVersions.personaId, id))
          .orderBy(desc(personaVersions.version)),
      );
    },
    version: async (id, version) => {
      await rowOf(id);
      const rows = await databaseOperation(() =>
        db
          .select()
          .from(personaVersions)
          .where(and(eq(personaVersions.personaId, id), eq(personaVersions.version, version))),
      );
      return requireVersion(rows, version);
    },
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
    publicList: () => databaseOperation(() => readPublicCatalog(binding, imageBase)),
    save: async (input, documents, expected) => {
      const record = decodePersona(input);
      if (record.published) {
        const issues = publicationIssues(record, documents);
        if (issues.length)
          throw new PersonaError("invalid", issues.map((issue) => issue.message).join(" "));
      }
      const previous = await currentPersonaRows(db).where(eq(personas.id, record.id)).get();
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
      const version = nextPersonaVersion(
        previous && { version: previous.currentVersion, prompt: previous.markdown },
        record.description!,
        expected.restoredFrom,
      );
      const values = { ...personaValues(record, documents, previous), currentVersion: version };
      const commitId = values.commitId;
      const ownsCommit = sql`exists (select 1 from ${personas} where ${personas.id} = ${record.id} and ${personas.commitId} = ${commitId})`;
      const write = previous
        ? db
            .update(personas)
            .set(values)
            .where(and(eq(personas.id, record.id), eq(personas.revision, previous.revision)))
        : db.insert(personas).values(values).onConflictDoNothing();
      const history =
        version !== previous?.currentVersion
          ? [
              db.insert(personaVersions).select(
                db
                  .select({
                    personaId: sql<string>`${record.id}`.as("personaId"),
                    version: sql<number>`${version}`.as("version"),
                    markdown: sql<string>`${record.description!}`.as("markdown"),
                    createdAt: sql<number>`${values.updatedAt}`.as("createdAt"),
                    restoredFrom: sql<number | null>`${expected.restoredFrom ?? null}`.as(
                      "restoredFrom",
                    ),
                  })
                  .from(personas)
                  .where(and(eq(personas.id, record.id), ownsCommit)),
              ),
            ]
          : [];
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
          ...history,
          db.delete(personaImages).where(and(eq(personaImages.personaId, record.id), ownsCommit)),
          ...inserts,
        ]),
      );
      if (!result.meta.changes)
        throw new PersonaError("conflict", "Persona가 변경되었습니다. 다시 열어 주세요.");
      return recordOf(
        {
          ...values,
          markdown: previous?.currentVersion === version ? previous.markdown : record.description!,
        },
        photos,
        imageBase,
      );
    },
  };
}
