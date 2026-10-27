import type { R2ListOptions } from "@cloudflare/workers-types";
import { PersonaError } from "@ren-ai/personas";
import { imageFilenamePattern, thumbnailKey } from "@ren-ai/personas/image-url";
import { putImmutable, type ImageBucket } from "./r2-images.ts";
import { thumbnail } from "./thumbnail.ts";
import { operation } from "./logging.ts";

type ListedBucket = ImageBucket & {
  list: (options: R2ListOptions) => Promise<{
    objects: readonly { key: string }[];
    truncated: boolean;
    cursor?: string;
  }>;
};

async function keys(bucket: ListedBucket, options: R2ListOptions) {
  const found: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ ...options, ...(cursor && { cursor }) });
    found.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return found;
}

/** Creates the missing display rendition of every stored original, including draft-only ones. */
export async function backfillThumbnails(bucket: ListedBucket, concurrency = 4) {
  const existing = new Set(await keys(bucket, { prefix: "thumbnails/" }));
  const missing = (await keys(bucket, { delimiter: "/" })).filter(
    (key) => imageFilenamePattern.test(key) && !existing.has(thumbnailKey(key)),
  );
  const report = { created: 0, existing: existing.size, unreadable: [] as string[] };
  const work = async () => {
    for (let key = missing.pop(); key; key = missing.pop()) {
      try {
        await operation("thumbnail.backfill.image", { operationId: key }, async () => {
          const original = await bucket.get(key);
          const bytes = thumbnail(new Uint8Array(await original!.arrayBuffer()));
          await putImmutable(bucket, thumbnailKey(key), bytes, "image/jpeg");
        });
        report.created++;
      } catch (cause) {
        if (!(cause instanceof PersonaError)) throw cause;
        report.unreadable.push(key);
      }
    }
  };
  // The caller may dispose its R2 proxy as soon as this returns, even on failure.
  const results = await Promise.allSettled(Array.from({ length: concurrency }, work));
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  return report;
}
