import { expect, test } from "vitest";
import { cloudflareFixture } from "../test/cloudflare-fixture.ts";
import { png, portraitImage } from "../test/fixtures.ts";
import { r2Images, imageKey } from "./r2-images.ts";

test("R2 image boundaries reject traversal, incorrect signatures and oversized uploads", async () => {
  const { bucket } = await cloudflareFixture();
  const images = r2Images(bucket);
  const local = r2Images(bucket, "/images/");
  expect(await local.saveImage(portraitImage)).toMatch(/^\/images\//);
  for (const filename of ["../private", "00000000-0000-0000-0000-000000000000.png"])
    expect((await images.image(filename)).status).toBe(404);
  for (const url of ["https://example.org/image.png", "/images/bad.png"])
    expect(() => imageKey(url)).toThrow("서비스에서 생성한 사진만");
  await expect(images.saveImage({ bytes: png, mimeType: "image/jpeg" })).rejects.toThrow(
    "올바른 PNG",
  );
  await expect(
    images.saveImage({ bytes: new Uint8Array(20_000_001), mimeType: "image/png" }),
  ).rejects.toThrow("올바른 PNG");
  const samples = [
    portraitImage,
    { bytes: Buffer.from("ffd8ff00", "hex"), mimeType: "image/jpeg" as const },
    { bytes: Buffer.from("524946460000000057454250", "hex"), mimeType: "image/webp" as const },
  ];
  for (const sample of samples) {
    const url = await images.saveImage(sample);
    expect(url).toMatch(/^https:\/\/persona-images\.renai\.im\//);
    expect((await bucket.head(imageKey(url)))!.httpMetadata!.cacheControl).toBe(
      "public, max-age=31536000, immutable",
    );
    const response = await images.image(imageKey(url));
    expect(response.headers.get("content-type")).toBe(sample.mimeType);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(sample.bytes));
  }
});
