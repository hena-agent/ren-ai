import { PersonaError } from "@ren-ai/personas";
import type { ImageModels } from "./image-model.ts";
import { operation, reportFailure, requestId } from "./logging.ts";

export async function imageModelRoute(request: Request, models: ImageModels | undefined) {
  const url = new URL(request.url);
  const headers = { "Cache-Control": "no-store" };
  try {
    if (request.method !== "GET") return new Response(null, { status: 405, headers });
    if (!models) throw new PersonaError("invalid", "이미지 모델 카탈로그가 연결되지 않았습니다.");
    const id = url.searchParams.get("model");
    if (id) {
      const selection = await operation("image.models.resolve", {}, () => models.resolve(id));
      return Response.json({ selection, quote: models.quote(selection) }, { headers });
    }
    const query = url.searchParams.get("q") ?? "";
    const cursor = url.searchParams.get("cursor");
    if (query.length > 200 || (cursor?.length ?? 0) > 1000)
      throw new PersonaError("invalid", "모델 검색 입력을 확인하세요.");
    return Response.json(
      await models.list(query, cursor, url.searchParams.get("refresh") === "1"),
      { headers },
    );
  } catch (cause) {
    reportFailure(
      cause,
      { stage: "image.models.request" },
      cause instanceof PersonaError ? "warn" : "error",
    );
    return Response.json(
      {
        error:
          cause instanceof PersonaError ? cause.message : "이미지 모델 정보를 읽지 못했습니다.",
        requestId: requestId(),
      },
      { status: cause instanceof PersonaError ? 400 : 503, headers },
    );
  }
}
