import { vi } from "vitest";
import { generator, portraitImage } from "./fixtures.ts";
import { durableFixture } from "./durable-admin.ts";

export async function durableArtworkFixture() {
  const rigArtwork = vi
    .fn<NonNullable<typeof generator.rigArtwork>>()
    .mockResolvedValue(portraitImage);
  return { ...(await durableFixture({ ...generator, rigArtwork })), rigArtwork };
}
