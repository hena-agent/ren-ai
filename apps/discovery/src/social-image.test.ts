// @vitest-environment node
import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { imageSize } from "image-size";
import { socialImage, brandSocialImage, personaPreview } from "./social-image.ts";
import { previewRoute } from "./public-routing.ts";
import { publicPersonas } from "../test/public-personas.ts";

test("published personas always advertise their own style-specific, versioned JPEG rendition", () => {
  const image = socialImage(publicPersonas[0], "photo");
  expect(image).toEqual({
    url: "https://renai.im/personas/jia/og/photo/00000000-0000-0000-0000-000000000002.v3.jpg",
    type: "image/jpeg",
    width: 1200,
    height: 630,
    alt: "백지아 — 실사 스타일의 AI 페르소나 프로필 사진과 RenAI 로고",
  });
  expect(socialImage(publicPersonas[0], "anime").url).toBe(
    "https://renai.im/personas/jia/og/anime/00000000-0000-0000-0000-000000000001.v3.jpg",
  );
  expect(personaPreview(publicPersonas[0]!, "photo")?.key).toBe(
    "00000000-0000-0000-0000-000000000002.jpg",
  );
});

test("only home or genuinely absent same-style gallery photos use the branded PNG", async () => {
  expect(socialImage(undefined, "anime")).toEqual(brandSocialImage);
  expect(socialImage(publicPersonas[1], "anime")).toEqual(brandSocialImage);
  expect(
    socialImage(
      {
        ...publicPersonas[0]!,
        portraits: { anime: publicPersonas[0]!.portraits!.anime! },
        secondaryPortraits: [],
      },
      "photo",
    ),
  ).toEqual(brandSocialImage);
  for (const locale of ["ko", "en", "ja"] as const) {
    const bytes = await readFile(new URL(`../public/social-${locale}-v3.png`, import.meta.url));
    expect(imageSize(bytes)).toMatchObject({ width: 1200, height: 630, type: "png" });
    expect(bytes.length).toBeLessThan(5_000_000);
    expect(socialImage(undefined, "anime", locale).url).toBe(
      `https://renai.im/social-${locale}-v3.png`,
    );
    expect(socialImage(publicPersonas[0], "photo", locale).alt).toContain("RenAI");
  }
});

test("renditions follow current gallery order and cannot turn arbitrary image URLs into R2 access", () => {
  const secondary = {
    ...publicPersonas[0]!,
    portraits: { photo: publicPersonas[0]!.portraits!.photo! },
  };
  expect(personaPreview(secondary, "anime")?.key).toBe("00000000-0000-0000-0000-000000000003.jpg");
  expect(() =>
    socialImage(
      {
        ...publicPersonas[0]!,
        portraits: { anime: "https://other.example/private.png" },
        secondaryPortraits: [],
      },
      "anime",
    ),
  ).toThrow("Public preview requires an owned gallery photo");
});

test("preview URLs reuse validated persona IDs and accept only explicit supported image styles", () => {
  expect(previewRoute(new URL(socialImage(publicPersonas[0], "photo").url))).toEqual({
    id: "jia",
    style: "photo",
  });
  expect(previewRoute(new URL(socialImage(publicPersonas[0], "anime").url))).toEqual({
    id: "jia",
    style: "anime",
  });
  expect(previewRoute(new URL("https://renai.im/personas/jia"))).toBeUndefined();
  expect(
    previewRoute(new URL("https://renai.im/personas/%3Cscript%3E/og/anime/image.v3.jpg")),
  ).toBeUndefined();
});
