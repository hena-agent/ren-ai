import type { PersonaStore } from "@ren-ai/personas";
import { validatePortrait } from "@ren-ai/personas";
import { readPortraitReference } from "./portrait-images.ts";
import { operation } from "./logging.ts";

/** Only the persisted same-style association can select an identity reference. */
export async function catalogSheet(request: Request, store: PersonaStore) {
  const query = new URL(request.url).searchParams;
  const id = query.get("id");
  const style = query.get("style");
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (!id || !/^[a-z0-9][a-z0-9_-]*$/.test(id) || (style !== "anime" && style !== "photo"))
    return new Response(null, { status: 400, headers });
  return operation("catalog.sheet", { personaId: id, style }, async () => {
    const sheets = await store.sheets(id);
    const reference = sheets[style];
    if (!reference) return new Response(null, { status: 404, headers });
    const image = await readPortraitReference(reference, style, store);
    validatePortrait(image);
    return new Response(new Uint8Array(image.bytes), {
      headers: { ...headers, "Content-Type": image.mimeType },
    });
  });
}
