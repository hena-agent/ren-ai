import { expect, test } from "vitest";
import {
  ownedImageKey,
  personaImageBase,
  thumbnailFilenamePattern,
  thumbnailKey,
  thumbnailUrl,
} from "./image-url.ts";

test("service-owned images display their stored thumbnail; other images have none", () => {
  const id = "01234567-89ab-cdef-0123-456789abcdef";
  for (const extension of ["png", "jpg", "webp"]) {
    const key = `${id}.${extension}`;
    expect(thumbnailKey(key)).toBe(`thumbnails/${id}.jpg`);
    expect(thumbnailFilenamePattern.test(thumbnailKey(key))).toBe(true);
    for (const base of [personaImageBase, "/images/", "http://127.0.0.1:3729/images/"])
      expect(thumbnailUrl(`${base}${key}`)).toBe(`${base}thumbnails/${id}.jpg`);
  }
  for (const url of [`https://example.net/${id}.png`, `${personaImageBase}thumbnails/${id}.jpg`])
    expect(thumbnailUrl(url)).toBe(url);
  expect(ownedImageKey(`${personaImageBase}thumbnails/${id}.jpg`)).toBeUndefined();
  for (const key of [`${id}.jpg`, `thumbnails/${id}.png`, `thumbnails/../${id}.jpg`])
    expect(thumbnailFilenamePattern.test(key)).toBe(false);
});

test("owned image URLs require the exact R2 or local image location and an unmodified filename", () => {
  const key = "01234567-89ab-cdef-0123-456789abcdef.jpg";
  for (const base of [
    personaImageBase,
    "/images/",
    "http://localhost:3729/images/",
    "http://127.0.0.1:3729/images/",
    "http://[::1]:3729/images/",
  ])
    expect(ownedImageKey(`${base}${key}`)).toBe(key);
  for (const url of [
    `https://example.net/${key}`,
    `https://persona-images.renai.im.evil.example/${key}`,
    `https://user@persona-images.renai.im/${key}`,
    `http://persona-images.renai.im/${key}`,
    `http://public.example:3729/images/${key}`,
    `${personaImageBase}${key}?query=1`,
    `${personaImageBase}${key}#fragment`,
    `${personaImageBase}../${key}`,
    `${personaImageBase}%2e%2e/${key}`,
    `${personaImageBase}folder/${key}`,
    `${personaImageBase}bad.jpg`,
    `/discovery/images/${key}`,
  ])
    expect(ownedImageKey(url)).toBeUndefined();
});
