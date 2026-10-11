import type { D1Database } from "@cloudflare/workers-types";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { personaImages } from "@ren-ai/personas";
import { personas, personaImages as photos } from "./database-schema.ts";
import { personaContent, personaValues, photoValues } from "./catalog-values.ts";
import { imageKey } from "./r2-images.ts";
import type { ImageBucket } from "./r2-images.ts";
import { imageHash, importImageBytes } from "./import-source.ts";
import type { ImportImage, ImportPersona, ImportSource } from "./import-source.ts";
import { operation, validationFailure } from "./logging.ts";

const ordered = (rows: readonly (typeof photos.$inferSelect)[]) =>
  rows.toSorted((a, b) => a.style.localeCompare(b.style) || a.position - b.position);

async function imageMatches(image: ImportImage, object: Awaited<ReturnType<ImageBucket["get"]>>) {
  return Boolean(
    object &&
    imageHash(new Uint8Array(await object.arrayBuffer())) === image.hash &&
    object.httpMetadata?.contentType === image.mimeType,
  );
}

async function currentMatches(binding: D1Database, input: ImportPersona, source: ImportSource) {
  const db = drizzle(binding);
  const current = await db.select().from(personas).where(eq(personas.id, input.record.id)).get();
  if (!current) return false;
  const {
    revision: _revision,
    commitId: _commitId,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...content
  } = current;
  if (JSON.stringify(content) !== JSON.stringify(personaContent(input.record, input.documents)))
    throw new Error(`Import ID conflicts with existing Persona ${input.record.id}`);
  const counts = { anime: 0, photo: 0 };
  const expected = personaImages(input.record).map((photo) => {
    const objectKey = imageKey(photo.imageUrl);
    const image = source.images.find((entry) => entry.key === objectKey)!;
    return {
      personaId: input.record.id,
      objectKey,
      style: photo.style,
      position: counts[photo.style]++,
      mimeType: image.mimeType,
      size: image.size,
    };
  });
  const existing = await db.select().from(photos).where(eq(photos.personaId, input.record.id));
  if (JSON.stringify(ordered(existing)) !== JSON.stringify(ordered(expected)))
    throw new Error(`Import photo links conflict for ${input.record.id}`);
  return true;
}

export async function importCatalog(
  binding: D1Database,
  bucket: ImageBucket,
  source: ImportSource,
  check: boolean,
  operationId: string,
) {
  try {
    const additions: ImportPersona[] = [];
    const uploads: (typeof source.images)[number][] = [];
    await operation("catalog.import.preflight", { operationId }, async () => {
      for (const input of source.personas)
        if (!(await currentMatches(binding, input, source))) additions.push(input);
      for (const image of source.images) {
        const existing = await bucket.get(image.key);
        if (!existing) {
          uploads.push(image);
          continue;
        }
        if (!(await imageMatches(image, existing)))
          throw new Error(`Import image key conflicts: ${image.key}`);
      }
    });
    if (!check) {
      await operation("catalog.import.upload", { operationId }, async () => {
        for (const image of uploads)
          await bucket.put(image.key, await importImageBytes(image), {
            httpMetadata: { contentType: image.mimeType },
          });
      });
      await operation("catalog.import.verify-images", { operationId }, async () => {
        for (const image of source.images)
          if (!(await imageMatches(image, await bucket.get(image.key))))
            throw new Error("Imported image verification failed");
      });
      await operation("catalog.import.commit", { operationId }, async () => {
        const db = drizzle(binding);
        const statements = [];
        for (const input of additions) {
          // One-off transfer preserves existing publication; normal authoring save still validates publication readiness.
          statements.push(db.insert(personas).values(personaValues(input.record, input.documents)));
          const links = await photoValues(input.record, bucket);
          if (links.length) statements.push(db.insert(photos).values(links));
        }
        const [first, ...rest] = statements;
        if (first) await db.batch([first, ...rest]);
      });
      await operation("catalog.import.verify", { operationId }, async () => {
        for (const input of source.personas)
          if (!(await currentMatches(binding, input, source)))
            throw new Error("Imported Persona is missing");
      });
    }
    return {
      check,
      personas: source.personas.length,
      images: source.images.length,
      personasAdded: additions.length,
      imagesUploaded: uploads.length,
      personasUnchanged: source.personas.length - additions.length,
      imagesUnchanged: source.images.length - uploads.length,
      missingInitial: source.personas
        .filter((input) => input.missingInitial)
        .map((input) => input.record.id),
      incompleteProfiles: source.personas
        .filter((input) => input.incompleteProfile)
        .map((input) => input.record.id),
    };
  } catch (cause) {
    throw validationFailure(
      "Local Catalog import failed",
      { stage: "catalog.import", code: "import_failed", operationId },
      cause,
    );
  }
}
