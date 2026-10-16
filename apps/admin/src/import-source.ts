import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  createPersonaStore,
  personaImages,
  publicationIssues,
  validatePortrait,
} from "@ren-ai/personas";
import type { InitialDocuments, PersonaRecord, Portrait } from "@ren-ai/personas";
import { imageKey } from "./r2-images.ts";
import { validationFailure } from "./logging.ts";

export interface ImportPersona {
  record: PersonaRecord;
  documents: InitialDocuments;
  missingInitial: boolean;
  incompleteProfile: boolean;
}
export interface ImportImage {
  key: string;
  file: string;
  size: number;
  mimeType: Portrait["mimeType"];
  hash: string;
}
export interface ImportSource {
  personas: readonly ImportPersona[];
  images: readonly ImportImage[];
}
export const imageHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function imageNames(directory: string) {
  try {
    return await readdir(directory);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
    throw cause;
  }
}

export async function readImportSource(directory: string): Promise<ImportSource> {
  try {
    await readdir(directory);
    const store = await createPersonaStore(directory);
    const records = await store.list();
    if (!records.length) throw new Error("No saved personas to import");
    const personas = await Promise.all(
      records.map(async (record) => {
        const initial = await store.initial(record.id);
        const documents = initial ?? { state: "", memory: "" };
        return {
          record,
          documents,
          missingInitial: !initial,
          incompleteProfile: publicationIssues(record, initial).length > 0,
        };
      }),
    );
    const images: ImportImage[] = [];
    for (const key of (await imageNames(join(directory, "images"))).toSorted()) {
      imageKey(`/images/${key}`);
      const file = join(directory, "images", key);
      const mimeType = key.endsWith(".png")
        ? "image/png"
        : key.endsWith(".jpg")
          ? "image/jpeg"
          : "image/webp";
      const bytes = await readFile(file);
      validatePortrait({ bytes, mimeType });
      images.push({ key, file, size: bytes.byteLength, mimeType, hash: imageHash(bytes) });
    }
    const available = new Set(images.map((image) => image.key));
    for (const record of records) {
      for (const photo of personaImages(record))
        if (!available.has(imageKey(photo.imageUrl)))
          throw new Error(`Missing referenced image for ${record.id}`);
      const main = record.portraits?.photo ?? record.portraits?.anime ?? record.imageUrl;
      if (record.imageUrl !== main)
        throw new Error(`Main image reference is inconsistent for ${record.id}`);
    }
    return { personas, images };
  } catch (cause) {
    throw validationFailure(
      "Saved Catalog input is invalid; inspect the source files",
      { stage: "catalog.import.read", code: "invalid_import_source" },
      cause,
    );
  }
}

export async function importImageBytes(image: ImportImage) {
  const details = await stat(image.file);
  if (!details.isFile()) throw new Error("Import image is not a regular file");
  const bytes = await readFile(image.file);
  if (imageHash(bytes) !== image.hash) throw new Error("Import image changed after inspection");
  return bytes;
}
