// @vitest-environment node
import { readFile } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { verifyPreview } from "./preview-deployment.ts";
import { publicPersonas } from "../test/public-personas.ts";
import { socialImage } from "./social-image.ts";

afterEach(() => vi.unstubAllGlobals());
const revision = "a".repeat(40);

async function fixture() {
  const jpeg = await readFile(new URL("../test/preview-rendition.jpg", import.meta.url));
  const response = (url: URL) => {
    if (url.pathname === "/health")
      return Response.json({ service: "discovery", revision, status: "ready" });
    if (url.pathname === "/discovery/personas")
      return Response.json({ people: publicPersonas, nextCursor: null });
    if (url.pathname.endsWith(".jpg"))
      return new Response(jpeg, { headers: { "Content-Type": "image/jpeg" } });
    const style = url.searchParams.get("style") === "photo" ? "photo" : "anime";
    return new Response(
      `<meta property="og:image" content="${socialImage(publicPersonas[0], style).url}">`,
    );
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (input) =>
      response(new URL(input instanceof Request ? input.url : input)),
    );
  return { fetcher, response };
}

test("deployment verification reads both advertised JPEGs, rather than accepting HTML status or a brand image", async () => {
  const f = await fixture();
  vi.stubGlobal("fetch", f.fetcher);
  expect(await verifyPreview("https://renai.im", revision)).toEqual({
    preview: "verified",
    styles: ["anime", "photo"],
  });
  expect(f.fetcher).toHaveBeenCalledTimes(6);
  expect(f.fetcher).toHaveBeenCalledWith(
    socialImage(publicPersonas[0], "photo").url,
    expect.objectContaining({ redirect: "manual" }),
  );
});

test("empty public Catalogs are reported explicitly and unavailable styles do not cause a false failure", async () => {
  const f = await fixture();
  f.fetcher.mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    return url.pathname === "/discovery/personas"
      ? Response.json({ people: [publicPersonas[1]], nextCursor: null })
      : f.response(url);
  });
  expect(await verifyPreview("https://renai.im", revision, f.fetcher)).toEqual({
    preview: "no_public_photos",
  });
  f.fetcher.mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    return url.pathname === "/discovery/personas"
      ? Response.json({
          nextCursor: null,
          people: [
            {
              ...publicPersonas[0],
              portraits: { photo: publicPersonas[0]!.portraits!.photo },
              secondaryPortraits: [],
            },
          ],
        })
      : f.response(url);
  });
  expect(await verifyPreview("https://renai.im", revision, f.fetcher)).toEqual({
    preview: "verified",
    styles: ["photo"],
  });
});

test.each([
  ["health", "/health"],
  ["catalog-http", "/discovery/personas"],
  ["catalog-json", "/discovery/personas"],
  ["profile", "/personas/jia"],
  ["brand", "/personas/jia"],
  ["image-http", ".jpg"],
  ["image-type", ".jpg"],
  ["image-dimensions", ".jpg"],
  ["image-size", ".jpg"],
])("%s cannot pass a preview deployment probe", async (failure, path) => {
  const f = await fixture();
  const brand = await readFile(new URL("../public/social-ko-v2.png", import.meta.url));
  f.fetcher.mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (!url.pathname.endsWith(path)) return f.response(url);
    if (failure === "health") return Response.json({ service: "wrong", revision, status: "ready" });
    if (failure === "catalog-http") return new Response(null, { status: 503 });
    if (failure === "catalog-json") return Response.json([{ private: "PRIVATE payload" }]);
    if (failure === "profile") return new Response(null, { status: 503 });
    if (failure === "brand")
      return new Response('<meta property="og:image" content="https://renai.im/social-ko-v2.png">');
    if (failure === "image-http") return new Response(null, { status: 503 });
    if (failure === "image-type") return new Response("HTML instead of image");
    if (failure === "image-dimensions")
      return new Response(brand, { headers: { "Content-Type": "image/jpeg" } });
    const data = new Uint8Array(5_000_001);
    const jpeg = new Uint8Array(await f.response(url).arrayBuffer());
    data.set(jpeg);
    return new Response(data, { headers: { "Content-Type": "image/jpeg" } });
  });
  await expect(verifyPreview("https://renai.im", revision, f.fetcher)).rejects.toThrow(
    /preview|Preview|identity|persona rendition/,
  );
});
