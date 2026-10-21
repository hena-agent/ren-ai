// @vitest-environment node
import { readFile } from "node:fs/promises";
import { expect, test, vi } from "vitest";
import { previewReady, previewResponse } from "./preview-image.ts";
import { socialImage } from "./social-image.ts";
import { previewFixture } from "../test/preview.ts";
import { publicPersonas } from "../test/public-personas.ts";

async function fixture() {
  const photo = await readFile(new URL("../public/landing/dohee-anime.webp", import.meta.url));
  const mark = await readFile(new URL("../public/og-watermark-v2.png", import.meta.url));
  const f = previewFixture(photo);
  const assets = vi
    .fn<(request: Request) => Promise<Response>>()
    .mockImplementation(async () => new Response(mark));
  return {
    ...f,
    ASSETS: { fetch: assets },
    assets,
    url: new URL(socialImage(publicPersonas[0], "anime").url),
  };
}

test("renditions read the published R2 object and compose a blurred backdrop, uncropped portrait and corner watermark", async () => {
  const f = await fixture();
  const response = await previewResponse(f.url, publicPersonas[0], "anime", f, f.cache);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/jpeg");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await response.text()).toBe("rendered-persona-preview");
  expect(f.PORTRAITS.get).toHaveBeenCalledExactlyOnceWith(
    "00000000-0000-0000-0000-000000000001.jpg",
  );
  expect(f.transform.mock.calls).toEqual([
    [{ width: 1200, height: 630, fit: "cover" }],
    [{ blur: 40, brightness: 0.65 }],
    [{ width: 600, height: 630, fit: "contain" }],
  ]);
  expect(f.draw).toHaveBeenCalledTimes(2);
  expect(f.draw.mock.calls[1]![1]).toEqual({ right: 28, bottom: 28 });
  expect(f.output).toHaveBeenCalledWith({ format: "image/jpeg", quality: 88, anim: false });
  expect(f.assets).toHaveBeenCalledWith(
    expect.objectContaining({ url: "https://renai.im/og-watermark-v2.png" }),
  );
  expect(f.cache.put).toHaveBeenCalledOnce();
});

test("current publication and gallery selection gate cached images as well as new renders", async () => {
  const f = await fixture();
  f.cache.match.mockResolvedValue(
    new Response("cached-public-rendition", { headers: { "Content-Type": "image/jpeg" } }),
  );
  const cached = await previewResponse(f.url, publicPersonas[0], "anime", f, f.cache);
  expect(await cached.text()).toBe("cached-public-rendition");
  expect(f.PORTRAITS.get).not.toHaveBeenCalled();
  for (const persona of [
    undefined,
    publicPersonas[1],
    {
      ...publicPersonas[0]!,
      portraits: { anime: publicPersonas[0]!.secondaryPortraits![0]!.imageUrl },
    },
  ]) {
    const response = await previewResponse(f.url, persona, "anime", f, f.cache);
    expect(response.status).toBe(404);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
  }
  expect(f.cache.match).toHaveBeenCalledOnce();
});

test.each(["missing", "oversized", "watermark-status", "watermark-body", "processor", "cache"])(
  "%s failures are not disguised as successful brand images",
  async (failure) => {
    const f = await fixture();
    if (failure === "missing") f.PORTRAITS.get.mockResolvedValue(null);
    if (failure === "oversized")
      f.PORTRAITS.get.mockResolvedValue({ body: new Response("photo").body!, size: 20_000_001 });
    if (failure === "watermark-status")
      f.assets.mockResolvedValue(new Response("failed", { status: 503 }));
    if (failure === "watermark-body") f.assets.mockResolvedValue(new Response(null));
    if (failure === "processor") f.output.mockRejectedValue(new Error("processor unavailable"));
    if (failure === "cache") f.cache.put.mockRejectedValue(new Error("cache unavailable"));
    await expect(previewResponse(f.url, publicPersonas[0], "anime", f, f.cache)).rejects.toThrow(
      /unavailable|limit/,
    );
  },
);

test("uncached local execution uses the same composition and health verifies R2 and the processor", async () => {
  const f = await fixture();
  expect((await previewResponse(f.url, publicPersonas[0], "anime", f)).status).toBe(200);
  await previewReady(f, f.url);
  expect(f.PORTRAITS.head).toHaveBeenCalledWith("og-readiness-probe");
  expect(f.IMAGE_TRANSFORMS.info).toHaveBeenCalledOnce();
});
