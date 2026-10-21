// @vitest-environment node
import { readFile } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import * as images from "image-size";
import { socialImage, brandSocialImage } from "./social-image.ts";
import { publicPersonas } from "../test/public-personas.ts";

afterEach(() => vi.restoreAllMocks());
const failed = () => vi.fn<(error: Error, stage: string, status: number | undefined) => void>();

test("social images use the first same-style published photo with actual MIME type and dimensions", async () => {
  const bytes = await readFile(new URL("../public/landing/dohee-anime.webp", import.meta.url));
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(bytes, { headers: { "Content-Type": "text/plain" } }));
  const report = failed();
  const image = await socialImage(publicPersonas[0], "photo", fetcher, report);
  expect(image).toEqual({
    url: "https://images.example/jia-photo.webp",
    type: "image/webp",
    width: 928,
    height: 1152,
    alt: "백지아 — 실사 스타일의 AI 페르소나 프로필 사진",
  });
  expect(fetcher).toHaveBeenCalledWith(image.url, expect.objectContaining({ redirect: "error" }));
  expect(report).not.toHaveBeenCalled();
});

test("home, absent photos and absent requested-style photos use the real 1200×630 branded PNG", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const report = failed();
  expect(await socialImage(undefined, "anime", fetcher, report)).toEqual(brandSocialImage);
  expect(await socialImage(publicPersonas[1], "anime", fetcher, report)).toEqual(brandSocialImage);
  expect(
    await socialImage(
      {
        ...publicPersonas[0]!,
        portraits: { anime: "https://images.example/only-anime.webp" },
        secondaryPortraits: [],
      },
      "photo",
      fetcher,
      report,
    ),
  ).toEqual(brandSocialImage);
  const bytes = await readFile(new URL("../public/social.png", import.meta.url));
  expect(images.imageSize(bytes)).toMatchObject({ width: 1200, height: 630, type: "png" });
  expect(fetcher).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
});

test.each([
  "http",
  "network",
  "header-size",
  "body-size",
  "invalid",
  "unsupported",
  "small",
  "short",
])(
  "%s image failure keeps the public profile usable with one observable branded preview",
  async (kind) => {
    const bytes = await readFile(new URL("../public/apple-touch-icon.png", import.meta.url));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes));
    if (kind === "http")
      fetcher.mockResolvedValue(new Response("private upstream payload", { status: 403 }));
    if (kind === "network") fetcher.mockRejectedValue("untrusted network failure");
    if (kind === "header-size")
      fetcher.mockResolvedValue(new Response(bytes, { headers: { "Content-Length": "5000001" } }));
    if (kind === "body-size") fetcher.mockResolvedValue(new Response(new Uint8Array(5_000_001)));
    if (kind === "invalid") fetcher.mockResolvedValue(new Response("not an image"));
    if (kind === "unsupported")
      fetcher.mockResolvedValue(
        new Response(await readFile(new URL("../public/brand.svg", import.meta.url))),
      );
    if (kind === "short")
      fetcher.mockResolvedValue(
        new Response(await readFile(new URL("../test/short-social.png", import.meta.url))),
      );
    const report = failed();
    expect(await socialImage(publicPersonas[0], "anime", fetcher, report)).toEqual(
      brandSocialImage,
    );
    expect(report).toHaveBeenCalledOnce();
  },
);
