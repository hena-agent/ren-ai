import { PersonaError, type PersonaStore } from "@ren-ai/personas";
import type { Draft } from "./draft.ts";
import type { ArtworkLayerizer } from "./artwork-layer-generation.ts";
import { operation, reportFailure, requestId, requestFields } from "./logging.ts";
import { artworkAsset, artworkTarget } from "./rig-artwork-target.ts";

export function captureArtworkLayers(
  draft: Draft,
  form: FormData,
  intent: string,
  service: ArtworkLayerizer | undefined,
) {
  if (intent !== "rig-layers") return draft;
  const target = artworkTarget(form.get("rigArtworkTarget"));
  const image = artworkAsset(draft.rigArtwork?.image, target);
  if (!image || !service)
    throw new PersonaError("invalid", "현재 원화와 FAL_KEY 연결을 먼저 확인하세요.");
  const layerize = service.selected(form.get("layerizeQuote"), image.operationId);
  return { ...draft, rigArtwork: { ...draft.rigArtwork!, layerize, target } };
}

export async function artworkLayerOptions(
  request: Request,
  store: PersonaStore,
  service: ArtworkLayerizer | undefined,
) {
  const headers = { "Cache-Control": "no-store" };
  try {
    if (request.method !== "GET")
      return new Response(null, { status: 405, headers: { ...headers, Allow: "GET" } });
    if (!service)
      throw new PersonaError("invalid", "FAL_KEY를 연결해야 레이어를 분리할 수 있습니다.");
    const params = new URL(request.url).searchParams;
    const id = params.get("persona");
    if (!id || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))
      throw new PersonaError("invalid", "페르소나를 선택하세요.");
    requestFields({ personaId: id });
    const image = artworkAsset(
      await operation("rig.layers.read", {}, () => store.rigArtwork(id)),
      artworkTarget(params.get("target")),
    );
    if (!image || image.operationId !== params.get("source"))
      throw new PersonaError("conflict", "원화가 변경되었습니다. 다시 열어 주세요.");
    return Response.json(await service.options(image.operationId), { headers });
  } catch (cause) {
    reportFailure(
      cause,
      { stage: "rig.layers.options" },
      cause instanceof PersonaError ? "warn" : "error",
    );
    return Response.json(
      {
        error:
          cause instanceof PersonaError ? cause.message : "레이어 분리 정보를 읽지 못했습니다.",
        requestId: requestId(),
      },
      {
        status: cause instanceof PersonaError ? (cause.kind === "conflict" ? 409 : 400) : 503,
        headers,
      },
    );
  }
}
