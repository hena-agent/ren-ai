import { PhotonImage } from "@cf-wasm/photon";
import { thumbnailKey } from "@ren-ai/personas/image-url";
import { afterEach, expect, test, vi } from "vitest";
import { cloudflareFixture } from "../test/cloudflare-fixture.ts";
import {
  character,
  fixture,
  jpeg,
  png,
  portraitImage,
  request,
  tokenOf,
  webp,
} from "../test/fixtures.ts";
import { r2Images, imageKey } from "./r2-images.ts";
import { createAdmin } from "./admin.ts";
import { croppedPng, uploadRequest } from "../test/upload-fixture.ts";

afterEach(() => vi.restoreAllMocks());

test.each(["malformed", "runtime"])(
  "%s thumbnail failures retain correlated diagnostics without image data",
  async (failure) => {
    const { bucket } = await cloudflareFixture();
    const { store, logs } = await fixture();
    const admin = createAdmin({ ...store, ...r2Images(bucket) }, "test-password", {
      log: (entry) => logs.push(entry),
    });
    const draft = tokenOf(await (await admin(request("/new"))).text());
    const bytes = croppedPng().subarray(0, 33);
    if (failure === "runtime")
      vi.spyOn(PhotonImage, "new_from_byteslice").mockImplementation(() => {
        throw Object.assign(new Error("codec unavailable"), { code: "ECODEC" });
      });
    const response = await admin(
      uploadRequest(draft, "style=photo", new Blob([bytes], { type: "image/png" })),
    );
    expect(response.status).toBe(failure === "malformed" ? 400 : 503);
    const failures = logs.filter(
      (entry) => entry.event === "operation.failed" && entry.stage === "image.upload.save",
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      requestId: response.headers.get("X-Request-ID"),
      stage: "image.upload.save",
      style: "photo",
      ...(failure === "malformed"
        ? {
            level: "warn",
            code: "invalid",
            error: { name: "RuntimeError", message: "unreachable" },
          }
        : { level: "error", code: "ECODEC", error: { message: "codec unavailable" } }),
    });
    expect((await bucket.list()).objects).toHaveLength(0);
    for (const secret of [character.description, draft, bytes.toString("base64")])
      expect(JSON.stringify(logs)).not.toContain(secret);
  },
);

const immutable = "public, max-age=31536000, immutable";

test("R2 image boundaries reject traversal, incorrect signatures and oversized uploads", async () => {
  const { bucket } = await cloudflareFixture();
  const images = r2Images(bucket);
  const local = r2Images(bucket, "/images/");
  expect(await local.saveImage(portraitImage)).toMatch(/^\/images\//);
  for (const filename of [
    "../private",
    "00000000-0000-0000-0000-000000000000.png",
    "thumbnails/00000000-0000-0000-0000-000000000000.jpg",
    "thumbnails/../private",
  ])
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
    { bytes: jpeg, mimeType: "image/jpeg" as const },
    { bytes: webp, mimeType: "image/webp" as const },
  ];
  for (const sample of samples) {
    const url = await images.saveImage(sample);
    expect(url).toMatch(/^https:\/\/persona-images\.renai\.im\//);
    expect((await bucket.head(imageKey(url)))!.httpMetadata!.cacheControl).toBe(immutable);
    const response = await images.image(imageKey(url));
    expect(response.headers.get("content-type")).toBe(sample.mimeType);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(sample.bytes));
    const thumbnail = await images.image(thumbnailKey(imageKey(url)));
    expect(thumbnail.headers.get("content-type")).toBe("image/jpeg");
    expect((await bucket.head(thumbnailKey(imageKey(url))))!.httpMetadata!.cacheControl).toBe(
      immutable,
    );
    expect(
      PhotonImage.new_from_byteslice(new Uint8Array(await thumbnail.arrayBuffer())).get_width(),
    ).toBe(1);
  }
});

test("saved images get a 640px JPEG thumbnail, and undecodable images store nothing", async () => {
  const { bucket } = await cloudflareFixture();
  const images = r2Images(bucket, "/images/");
  const wide = new PhotonImage(new Uint8Array(1600 * 1000 * 4).fill(200), 1600, 1000);
  const url = await images.saveImage({ bytes: wide.get_bytes(), mimeType: "image/png" });
  const thumbnail = await images.image(thumbnailKey(imageKey(url)));
  const decoded = PhotonImage.new_from_byteslice(new Uint8Array(await thumbnail.arrayBuffer()));
  expect([decoded.get_width(), decoded.get_height()]).toEqual([640, 400]);
  await expect(
    images.saveImage({ bytes: jpeg.subarray(0, 4), mimeType: "image/jpeg" }),
  ).rejects.toThrow("올바른 PNG");
  expect((await bucket.list()).objects).toHaveLength(2);
});
