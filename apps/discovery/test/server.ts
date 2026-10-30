import { readFile } from "node:fs/promises";
import { vi } from "vitest";
import { discoveryServer } from "../src/server.ts";
import type { ServerEvent } from "../src/server-log.ts";
import { publicPersonas } from "./public-personas.ts";
import { previewFixture } from "./preview.ts";
import { staticPages } from "../src/prerender.ts";

export const animePreview =
  "https://renai.im/personas/jia/og/anime/00000000-0000-0000-0000-000000000001.v3.jpg";
export const photoPreview =
  "https://renai.im/personas/jia/og/photo/00000000-0000-0000-0000-000000000002.v3.jpg";

export async function fixture() {
  const template = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const { "index.html": home } = await staticPages(template);
  const photo = await readFile(new URL("../public/landing/dohee-anime.webp", import.meta.url));
  const mark = await readFile(new URL("../public/og-watermark-v3.png", import.meta.url));
  const preview = previewFixture(photo);
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    return Response.json(
      path === "/discovery/persona-links"
        ? publicPersonas.map((persona) => ({
            id: persona.id,
            imageUrl: persona.portraits?.anime ?? persona.imageUrl,
          }))
        : path === "/discovery/personas"
          ? { people: publicPersonas, nextCursor: "next-page" }
          : publicPersonas,
    );
  });
  const assets = vi
    .fn<(request: Request) => Promise<Response>>()
    .mockImplementation(async (request) => {
      const path = new URL(request.url).pathname;
      // Real fetch responses enforce the immutable headers returned by Cloudflare ASSETS.
      return path === "/og-watermark-v3.png"
        ? new Response(mark)
        : fetch(
            `data:text/html;charset=utf-8;base64,${Buffer.from(path === "/" ? home : template).toString("base64")}`,
          );
    });
  const log = vi.fn<(event: ServerEvent) => void>();
  const handler = discoveryServer(fetcher, log);
  const env = { ...preview, ASSETS: { fetch: assets }, DISCOVERY_API_URL: "https://api.example" };
  return {
    ...preview,
    fetcher,
    assets,
    log,
    send: (path: string, method = "GET", headers: HeadersInit = {}) =>
      handler(new Request(`https://renai.im${path}`, { method, headers }), env, preview.cache),
  };
}
