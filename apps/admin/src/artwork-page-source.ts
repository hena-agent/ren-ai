import { PersonaError, type PersonaStore } from "@ren-ai/personas";
import { operation, requestFields } from "./logging.ts";

export function artworkMutationId(
  request: Request,
  url: URL,
  route: "rig-face" | "artwork-layers/layout",
) {
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  if (request.headers.get("origin") !== url.origin)
    throw new PersonaError("invalid", "같은 Admin 화면에서 요청해 주세요.");
  const match = new RegExp(`^/personas/([a-zA-Z0-9_-]+)/${route}$`).exec(url.pathname);
  if (!match) return new Response(null, { status: 404 });
  requestFields({ personaId: match[1]! });
  return match[1]!;
}

export async function artworkPageSource(request: Request, url: URL, store: PersonaStore) {
  if (request.method !== "GET")
    return new Response(null, { status: 405, headers: { Allow: "GET" } });
  const match = /^\/personas\/([a-zA-Z0-9_-]+)\/(?:rig-test|artwork-layers)$/.exec(url.pathname);
  if (!match) return new Response(null, { status: 404 });
  const id = match[1]!;
  requestFields({ personaId: id });
  const persona = await operation("persona.read", {}, () => store.get(id));
  const artwork = await operation("rig.artwork.read", {}, () => store.rigArtwork(id));
  if (!artwork) throw new PersonaError("not_found", "먼저 이 페르소나의 원화를 생성해 주세요.");
  return { id, persona, artwork };
}
