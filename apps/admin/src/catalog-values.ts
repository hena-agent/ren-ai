import { PersonaError, personaImages } from "@ren-ai/personas";
import type { InitialDocuments, PersonaRecord } from "@ren-ai/personas";
import type { personas } from "./database-schema.ts";
import { imageKey } from "./r2-images.ts";
import type { ImageBucket } from "./r2-images.ts";

export const personaContent = (record: PersonaRecord, documents: InitialDocuments) => ({
  id: record.id,
  name: record.name,
  gender: record.gender ?? null,
  descriptionVersion: record.descriptionVersion ?? null,
  markdown: record.description!,
  timeZone: record.timeZone,
  language: record.language,
  openingLine: record.openingLine,
  memoryInstruction: record.memory,
  published: record.published,
  state: documents.state,
  memory: documents.memory,
});

export function personaValues(
  record: PersonaRecord,
  documents: InitialDocuments,
  previous?: Pick<typeof personas.$inferSelect, "revision" | "createdAt">,
) {
  return {
    ...personaContent(record, documents),
    revision: (previous?.revision ?? 0) + 1,
    commitId: crypto.randomUUID(),
    createdAt: previous?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
}

export async function photoValues(record: PersonaRecord, bucket: ImageBucket) {
  const counts = { anime: 0, photo: 0 };
  return Promise.all(
    personaImages(record).map(async (photo) => {
      const objectKey = imageKey(photo.imageUrl);
      const object = await bucket.head(objectKey);
      if (!object) throw new PersonaError("invalid", "저장된 사진을 찾을 수 없습니다.");
      return {
        personaId: record.id,
        objectKey,
        style: photo.style,
        position: counts[photo.style]++,
        mimeType: object.httpMetadata!.contentType!,
        size: object.size,
      };
    }),
  );
}
