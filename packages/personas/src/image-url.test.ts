import { expect, test } from "vitest";
import { ownedImageKey, personaImageBase } from "./image-url.ts";

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
