import { vi } from "vitest";
import type { RigArtworkLayers } from "@ren-ai/personas";
import { createArtworkLayerizer } from "../src/artwork-layer-generation.ts";
import { artworkLayerModel } from "../src/artwork-layer-model.ts";
import { png } from "./fixtures.ts";
import { fetchUrl } from "./fetch-url.ts";

export const layerResponse = {
  layers: [
    { image: { url: "https://v3b.fal.media/base.png" }, z_index: 0 },
    {
      image: { url: "https://v3b.fal.media/arm.png" },
      z_index: 1,
      name: "Left arm",
      bounding_box: { absolute: [0, 0, 1, 1] as const },
    },
  ],
};
export const layerFetch: typeof fetch = async (input, init) => {
  const url = fetchUrl(input);
  if (url.includes("/pricing?"))
    return Response.json({
      prices: [{ endpoint_id: artworkLayerModel, unit_price: 0.03375, currency: "USD" }],
    });
  if (url.includes("/storage/upload/initiate"))
    return Response.json({
      file_url: "https://v3b.fal.media/source.png",
      upload_url: "https://v3b.fal.media/upload",
    });
  if (init?.method === "PUT") return Response.json({});
  if (init?.method === "POST") return Response.json({ request_id: "test-layer-request" });
  if (url.endsWith("/status")) return Response.json({ status: "COMPLETED" });
  if (url.includes("/requests/")) return Response.json(layerResponse);
  if (url.startsWith("https://v3b.fal.media/"))
    return new Response(png, { headers: { "Content-Type": "image/png" } });
  throw new Error("Unexpected test request");
};
export function layerService() {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(layerFetch);
  return { fetcher, service: createArtworkLayerizer("layer-key", "test-password", fetcher) };
}
export function storedLayers(
  imageUrl: string,
  sourceOperationId = "art-source",
  operationId = "layer-result",
): RigArtworkLayers {
  return {
    model: artworkLayerModel,
    sourceOperationId,
    operationId,
    width: 1,
    height: 1,
    layers: [
      { name: "Base", zIndex: 0, imageUrl, width: 1, height: 1, bounds: [0, 0, 1, 1] },
      { name: "Left arm", zIndex: 1, imageUrl, width: 1, height: 1, bounds: [0, 0, 1, 1] },
    ],
  };
}
