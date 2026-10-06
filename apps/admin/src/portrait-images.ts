import { Schema } from "effect";
import { PersonaError, personaImages } from "@ren-ai/personas";
import type { createPersonaStore, PersonaRecord, Portrait } from "@ren-ai/personas";
import { operation, GenerationError } from "./logging.ts";
import copy from "./copy.json";

export const mainImage = (persona: PersonaRecord, style: "anime" | "photo") =>
  personaImages(persona).find((image) => image.main && image.style === style)?.imageUrl;

export function imageStyle(params: URLSearchParams): "anime" | "photo" {
  const style = params.get("style");
  if (style !== "anime" && style !== "photo")
    throw new PersonaError("invalid", copy.imageTargetRequired);
  return style;
}

export function imageTarget(
  persona: PersonaRecord,
  params: URLSearchParams,
): { index: number; style: "anime" | "photo"; url: string } {
  const style = imageStyle(params);
  const images = personaImages(persona).filter((image) => image.style === style);
  const value = params.get("image");
  const index = /^[0-5]$/.test(String(value))
    ? Number(value)
    : images.findIndex((image) => image.imageUrl === value);
  const image = images[index];
  if (!image) throw new PersonaError("invalid", copy.imageTargetRequired);
  return { index, style, url: image.imageUrl };
}

export async function readPortraitReference(
  url: string,
  style: "anime" | "photo",
  store: Awaited<ReturnType<typeof createPersonaStore>>,
) {
  if (!url.startsWith("/discovery/images/"))
    throw new PersonaError("invalid", copy.baseOwnedRequired);
  return operation("portrait.reference.read", { style }, async (): Promise<Portrait> => {
    const response = await store.image(url.slice("/discovery/images/".length));
    if (!response.ok)
      throw new GenerationError("Base portrait unavailable", {
        code: "reference_unavailable",
        status: response.status,
      });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > 20_000_000)
      throw new GenerationError("Base portrait too large", { code: "invalid_reference" });
    try {
      return {
        bytes,
        mimeType: Schema.decodeUnknownSync(
          Schema.Literals(["image/png", "image/jpeg", "image/webp"]),
        )(response.headers.get("content-type")),
      };
    } catch {
      throw new GenerationError("Invalid base portrait type", { code: "invalid_reference" });
    }
  });
}
