import type {
  ImageTransform,
  ImageDrawOptions,
  ImageOutputOptions,
} from "@cloudflare/workers-types";
import type { PublicPersona } from "@ren-ai/onboarding";
import type { ImageStyle } from "./image-style.ts";
import { personaPreview } from "./social-image.ts";

// Keep Web streams/Responses in the app's DOM type universe; Cloudflare's option
// types are shared, while its independently declared stream types are not.
interface PreviewPipeline {
  transform: (options: ImageTransform) => PreviewPipeline;
  draw: (
    image: PreviewPipeline | ReadableStream<Uint8Array>,
    options?: ImageDrawOptions,
  ) => PreviewPipeline;
  output: (
    options: ImageOutputOptions,
  ) => Promise<{ response: (options?: { headers?: HeadersInit }) => Response }>;
}
export interface PreviewEnv {
  PORTRAITS: {
    get: (key: string) => Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>;
    head: (key: string) => Promise<object | null>;
  };
  IMAGE_TRANSFORMS: {
    input: (source: ReadableStream<Uint8Array>) => PreviewPipeline;
    info: (source: ReadableStream<Uint8Array>) => Promise<{ format: string }>;
  };
  ASSETS: { fetch: (request: Request) => Promise<Response> };
}
export type PreviewCache = Pick<Cache, "match" | "put">;

async function watermark(env: PreviewEnv, url: URL) {
  const asset = await env.ASSETS.fetch(new Request(new URL("/og-watermark-v1.png", url)));
  if (!asset.ok || !asset.body)
    throw Object.assign(new Error("Preview watermark unavailable"), {
      code: "PREVIEW_WATERMARK_UNAVAILABLE",
    });
  return asset.body;
}

export async function previewReady(env: PreviewEnv, url: URL) {
  await env.PORTRAITS.head("og-readiness-probe");
  await env.IMAGE_TRANSFORMS.info(await watermark(env, url));
}

export async function previewResponse(
  url: URL,
  persona: PublicPersona | undefined,
  style: ImageStyle,
  env: PreviewEnv,
  cache?: PreviewCache,
) {
  const preview = persona && personaPreview(persona, style);
  if (!preview || new URL(preview.url).pathname !== url.pathname)
    return new Response(null, { status: 404, headers: { "X-Robots-Tag": "noindex" } });
  // Publication and current gallery order are checked before consulting the rendition cache.
  const key = new Request(preview.url);
  const cached = await cache?.match(key);
  if (cached) return new Response(cached.body, cached);
  const source = await env.PORTRAITS.get(preview.key);
  if (!source)
    throw Object.assign(new Error("Published preview photo unavailable"), {
      code: "PREVIEW_PHOTO_MISSING",
    });
  if (source.size > 20_000_000)
    throw Object.assign(new Error("Preview source exceeds image processor limit"), {
      code: "PREVIEW_SOURCE_TOO_LARGE",
    });
  const [background, foreground] = source.body.tee();
  const logo = await watermark(env, url);
  const images = env.IMAGE_TRANSFORMS;
  const result = await images
    .input(background)
    .transform({ width: 1200, height: 630, fit: "cover" })
    .transform({ blur: 40, brightness: 0.65 })
    .draw(images.input(foreground).transform({ width: 600, height: 630, fit: "contain" }))
    .draw(logo, { right: 28, bottom: 28 })
    .output({ format: "image/jpeg", quality: 88, anim: false });
  const response = result.response({
    headers: {
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
  await cache?.put(key, response.clone());
  return response;
}
