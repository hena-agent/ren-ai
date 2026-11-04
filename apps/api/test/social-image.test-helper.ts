import { Schema } from "effect";
import { vi } from "vitest";
import { SocialResult } from "@ren-ai/onboarding/social";
import type { SocialImagesBackend } from "../src/social/images.ts";
import { socialTestContext } from "./social.test-helper.ts";

export const imagePolicy = { enabled: true, credits: 4, style: "photo" as const };
export function imageBackendFixture() {
  const objects = new Map<string, Uint8Array>();
  const api: SocialImagesBackend = {
    generate: vi.fn<SocialImagesBackend["generate"]>(async (input) => {
      await input.beforeDispatch();
      return new Uint8Array([255, 216, 1, 255, 217]);
    }),
    get: async (id) => objects.get(id),
    put: async (id, bytes) => {
      objects.set(id, bytes);
    },
    remove: async (id) => {
      objects.delete(id);
    },
  };
  return { api, objects };
}
export function socialImageTestContext() {
  const context = socialTestContext();
  return {
    ...context,
    queued: async () => {
      const b = imageBackendFixture(),
        f = context.fixture({ images: b.api });
      await f.enable({ images: imagePolicy });
      const result = Schema.decodeUnknownSync(SocialResult)(
        await (
          await f.action(0, {
            kind: "image_idea",
            scene: "PRIVATE_SCENE",
            creativeScene: "PRIVATE_ART",
            probability: 10000,
          })
        ).json(),
      );
      if (!result.image) throw new Error("Image fixture did not enqueue an image");
      return { ...f, ...b, id: result.image.id };
    },
  };
}
export async function approveImage(
  f: Awaited<ReturnType<ReturnType<typeof socialImageTestContext>["queued"]>>,
) {
  await f.app.alarm();
  await f.request("/image", { runId: f.runs[0]!.id, imageId: f.id });
  const response = await f.action(1, { kind: "review_image", imageId: f.id, accept: true });
  if (response.status !== 200) throw new Error("Image fixture was not approved");
}
