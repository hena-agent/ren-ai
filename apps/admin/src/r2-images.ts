import type { R2Object, R2ObjectBody } from "@cloudflare/workers-types";
import { PersonaError, validatePortrait } from "@ren-ai/personas";
import type { Portrait } from "@ren-ai/personas";
import { imageFilenamePattern, ownedImageKey, personaImageBase } from "@ren-ai/personas/image-url";

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

export function r2Images(bucket: ImageBucket, imageBase = personaImageBase) {
  return {
    saveImage: async (image: Portrait) => {
      validatePortrait(image);
      const key = `${crypto.randomUUID()}.${formats[image.mimeType]}`;
      await bucket.put(key, image.bytes, {
        httpMetadata: {
          contentType: image.mimeType,
          cacheControl: "public, max-age=31536000, immutable",
        },
      });
      return `${imageBase}${key}`;
    },
    image: async (filename: string) => {
      if (!imageFilenamePattern.test(filename)) return new Response(null, { status: 404 });
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
