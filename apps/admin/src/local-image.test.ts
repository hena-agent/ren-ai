import { expect, test } from "vitest";
import { fromPartial } from "@total-typescript/shoehorn";
import type { ImageBucket } from "./r2-images.ts";
import type { LogEntry } from "./logging.ts";
import { localImageRequest } from "./local-image.ts";
import { cloudflareFixture } from "../test/cloudflare-fixture.ts";
import { portraitImage } from "../test/fixtures.ts";

test("local GET returns the original image bytes and HEAD retains metadata without a body", async () => {
  const { store, bucket } = await cloudflareFixture();
  const imageUrl = await store.saveImage(portraitImage);
  const url = `http://localhost/images/${imageUrl.split("/").at(-1)!}`;
  const events: LogEntry[] = [];
  const log = (event: LogEntry) => events.push(event);
  const image = await localImageRequest(new Request(url), bucket, log);
  expect(image.status).toBe(200);
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array(portraitImage.bytes));
  const head = await localImageRequest(new Request(url, { method: "HEAD" }), bucket, log);
  expect(head.status).toBe(200);
  expect(head.headers.get("content-type")).toBe(portraitImage.mimeType);
  expect(head.headers.get("cache-control")).toBe("no-store");
  expect(await head.text()).toBe("");
  expect(events.some((entry) => entry.event === "operation.failed")).toBe(false);
});

test("local image read failures log a safe cause once and return the request ID", async () => {
  const entries: LogEntry[] = [];
  const bucket = fromPartial<ImageBucket>({
    get: async () => {
      throw Object.assign(new Error("private image bytes"), { code: "R2_UNAVAILABLE" });
    },
  });
  const response = await localImageRequest(
    new Request("http://localhost/images/01234567-89ab-cdef-0123-456789abcdef.png"),
    bucket,
    (entry) => entries.push(entry),
  );
  const requestId = response.headers.get("x-request-id");
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "Image unavailable", requestId });
  const failures = entries.filter((entry) => entry.event === "operation.failed");
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({
    requestId,
    stage: "image.read",
    code: "image_read_failed",
    causeCode: "R2_UNAVAILABLE",
  });
  expect(JSON.stringify(entries)).not.toContain("private image bytes");
  expect(
    (
      await localImageRequest(
        new Request("http://localhost/images/01234567-89ab-cdef-0123-456789abcdef.png", {
          method: "POST",
        }),
        bucket,
        (entry) => entries.push(entry),
      )
    ).status,
  ).toBe(404);
});
