import { fromPartial } from "@total-typescript/shoehorn";
import { expect, test, vi } from "vitest";
import { databasePersona } from "../test/cloudflare-fixture.ts";
import { photoValues } from "./catalog-values.ts";
import type { ImageBucket } from "./r2-images.ts";
import { deferred } from "../test/queue.ts";

test("photo positions retain operator order when secondary metadata resolves first", async () => {
  const primary = deferred<Awaited<ReturnType<ImageBucket["head"]>>>();
  const secondary = deferred<Awaited<ReturnType<ImageBucket["head"]>>>();
  const head = vi
    .fn<ImageBucket["head"]>()
    .mockReturnValueOnce(primary.promise)
    .mockReturnValueOnce(secondary.promise);
  const mainKey = "00000000-0000-4000-8000-000000000001.png";
  const secondaryKey = "00000000-0000-4000-8000-000000000002.png";
  const base = "https://persona-images.renai.im/";
  const saved = photoValues(
    {
      ...databasePersona,
      imageUrl: base + mainKey,
      portraits: { photo: base + mainKey },
      secondaryPortraits: [{ style: "photo", imageUrl: base + secondaryKey }],
    },
    fromPartial<ImageBucket>({ head }),
  );
  const metadata = { size: 1, httpMetadata: { contentType: "image/png" } };
  secondary.resolve(metadata);
  await secondary.promise;
  primary.resolve(metadata);
  expect((await saved).map(({ objectKey, position }) => ({ objectKey, position }))).toEqual([
    { objectKey: mainKey, position: 0 },
    { objectKey: secondaryKey, position: 1 },
  ]);
});
