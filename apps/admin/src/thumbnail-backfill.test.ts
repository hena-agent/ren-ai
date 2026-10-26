import { thumbnailKey } from "@ren-ai/personas/image-url";
import { expect, test, vi } from "vitest";
import { cloudflareFixture } from "../test/cloudflare-fixture.ts";
import { jpeg, png, portraitImage } from "../test/fixtures.ts";
import { putImmutable, r2Images, imageKey } from "./r2-images.ts";
import { backfillThumbnails } from "./thumbnail-backfill.ts";
import { loggedJob, type LogEntry } from "./logging.ts";
import { deferred } from "../test/queue.ts";

test("backfill drains in-flight writes and diagnoses each failure before returning", async () => {
  const { bucket } = await cloudflareFixture();
  const keys = [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png",
  ];
  for (const key of keys) await putImmutable(bucket, key, png, "image/png");
  const pending = deferred<void>();
  const logs: LogEntry[] = [];
  let finished = false;
  let started = 0;
  const run = loggedJob(
    "backfill-run",
    {},
    () =>
      backfillThumbnails({
        head: bucket.head.bind(bucket),
        get: bucket.get.bind(bucket),
        list: bucket.list.bind(bucket),
        put: async (key) => {
          started++;
          if (key === thumbnailKey(keys[0]!)) await pending.promise;
          throw Object.assign(new Error("R2 unavailable"), { code: "R2_OFFLINE" });
        },
      }),
    (entry) => logs.push(entry),
  )
    .catch((error: Error) => error)
    .finally(() => {
      finished = true;
    });
  await vi.waitFor(() => expect(started).toBe(2));
  const finishedBeforeWrite = finished;
  pending.resolve();
  expect(await run).toMatchObject({ message: "R2 unavailable" });
  expect(finishedBeforeWrite).toBe(false);
  const failures = logs.filter((entry) => entry.event === "operation.failed");
  expect(failures).toHaveLength(2);
  for (const entry of failures)
    expect(entry).toMatchObject({
      requestId: "backfill-run",
      stage: "thumbnail.backfill.image",
      code: "R2_OFFLINE",
      level: "error",
    });
});

test("the backfill thumbnails every stored original once and reports unreadable ones", async () => {
  const { bucket } = await cloudflareFixture();
  const saved = imageKey(await r2Images(bucket).saveImage(portraitImage));
  const earlier = [
    "11111111-1111-4111-8111-111111111111.png",
    "22222222-2222-4222-8222-222222222222.jpg",
  ];
  await putImmutable(bucket, earlier[0]!, png, "image/png");
  await putImmutable(bucket, earlier[1]!, jpeg, "image/jpeg");
  const unreadable = "33333333-3333-4333-8333-333333333333.webp";
  await putImmutable(bucket, unreadable, new Uint8Array([82, 73, 70, 70]), "image/webp");
  await putImmutable(bucket, "og-readiness-probe", new Uint8Array(), "text/plain");
  // One object per page exercises listing continuation.
  const paged = {
    head: (key: string) => bucket.head(key),
    get: (key: string) => bucket.get(key),
    put: bucket.put.bind(bucket),
    list: (options: object) => bucket.list({ ...options, limit: 1 }),
  };
  const logs: LogEntry[] = [];
  const run = (input = paged) =>
    loggedJob(
      "backfill",
      {},
      () => backfillThumbnails(input),
      (entry) => logs.push(entry),
    );
  expect(await run()).toEqual({
    created: 2,
    existing: 1,
    unreadable: [unreadable],
  });
  expect(logs.find((entry) => entry.event === "operation.failed")).toMatchObject({
    requestId: "backfill",
    stage: "thumbnail.backfill.image",
    operationId: unreadable,
    level: "warn",
    code: "invalid",
    error: { name: "RuntimeError", message: "unreachable" },
  });
  for (const key of [saved, ...earlier])
    expect((await bucket.head(thumbnailKey(key)))?.httpMetadata).toEqual({
      contentType: "image/jpeg",
      cacheControl: "public, max-age=31536000, immutable",
    });
  expect(await run()).toEqual({
    created: 0,
    existing: 3,
    unreadable: [unreadable],
  });
  const failing = { ...paged, put: () => Promise.reject(new Error("R2 unavailable")) };
  await putImmutable(bucket, "44444444-4444-4444-8444-444444444444.png", png, "image/png");
  await expect(run(failing)).rejects.toThrow("R2 unavailable");
});
