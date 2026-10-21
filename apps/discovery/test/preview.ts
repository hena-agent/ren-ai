import { vi } from "vitest";
import type { PreviewEnv, PreviewCache } from "../src/preview-image.ts";

type PreviewPipeline = ReturnType<PreviewEnv["IMAGE_TRANSFORMS"]["input"]>;

export function previewFixture(photo: Uint8Array) {
  const transform = vi.fn<PreviewPipeline["transform"]>();
  const draw = vi.fn<PreviewPipeline["draw"]>();
  const output = vi.fn<PreviewPipeline["output"]>().mockResolvedValue({
    response: (options) => {
      const headers = new Headers(options?.headers);
      headers.set("Content-Type", "image/jpeg");
      return new Response("rendered-persona-preview", { headers });
    },
  });
  const pipeline: PreviewPipeline = { transform, draw, output };
  transform.mockReturnValue(pipeline);
  draw.mockReturnValue(pipeline);
  const get = vi.fn<PreviewEnv["PORTRAITS"]["get"]>().mockImplementation(async () => ({
    body: new Response(new Uint8Array(photo)).body!,
    size: photo.length,
  }));
  const head = vi.fn<PreviewEnv["PORTRAITS"]["head"]>().mockResolvedValue(null);
  const input = vi.fn<PreviewEnv["IMAGE_TRANSFORMS"]["input"]>().mockReturnValue(pipeline);
  const info = vi
    .fn<PreviewEnv["IMAGE_TRANSFORMS"]["info"]>()
    .mockResolvedValue({ format: "image/png" });
  const match = vi.fn<PreviewCache["match"]>().mockResolvedValue(undefined);
  const put = vi.fn<PreviewCache["put"]>().mockResolvedValue(undefined);
  return {
    PORTRAITS: { get, head },
    IMAGE_TRANSFORMS: { input, info },
    cache: { match, put },
    transform,
    draw,
    output,
  };
}
