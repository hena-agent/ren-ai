import type { R2Object, R2ObjectBody } from "@cloudflare/workers-types";
import { PersonaError, validatePortrait } from "@ren-ai/personas";
import type { Portrait } from "@ren-ai/personas";
import {
  imageFilenamePattern,
  ownedImageKey,
  personaImageBase,
  thumbnailFilenamePattern,
  thumbnailKey,
} from "@ren-ai/personas/image-url";
import { thumbnail } from "./thumbnail.ts";

const formats = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

export interface ImageBucket {
  head: (key: string) => Promise<Pick<R2Object, "size" | "httpMetadata"> | null>;
  get: (key: string) => Promise<Pick<R2ObjectBody, "arrayBuffer" | "httpMetadata"> | null>;
  put: (
    key: string,
    bytes: Uint8Array,
    options: { httpMetadata: { contentType: string; cacheControl?: string } },
  ) => Promise<object | null>;
}

export function imageKey(url: string) {
  const key = ownedImageKey(url);
  if (!key) throw new PersonaError("invalid", "서비스에서 생성한 사진만 저장할 수 있습니다.");
  return key;
}

/** Stores an immutable object; the edge and browsers may cache it for a year. */
export const putImmutable = (
  bucket: ImageBucket,
  key: string,
  bytes: Uint8Array,
  contentType: string,
) =>
  bucket.put(key, bytes, {
    httpMetadata: { contentType, cacheControl: "public, max-age=31536000, immutable" },
  });

export function r2Images(bucket: ImageBucket, imageBase = personaImageBase) {
  return {
    saveImage: async (image: Portrait) => {
      validatePortrait(image);
      const key = `${crypto.randomUUID()}.${formats[image.mimeType]}`;
      // The display rendition lands first, so every stored original has one.
      await putImmutable(bucket, thumbnailKey(key), thumbnail(image.bytes), "image/jpeg");
      await putImmutable(bucket, key, image.bytes, image.mimeType);
      return `${imageBase}${key}`;
    },
    image: async (filename: string) => {
      if (!imageFilenamePattern.test(filename) && !thumbnailFilenamePattern.test(filename))
        return new Response(null, { status: 404 });
      const image = await bucket.get(filename);
      if (!image) return new Response(null, { status: 404 });
      return new Response(new Uint8Array(await image.arrayBuffer()), {
        headers: {
          "Content-Type": image.httpMetadata!.contentType!,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
        },
      });
    },
  };
}
