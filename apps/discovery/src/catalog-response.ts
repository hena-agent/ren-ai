import type { D1Database } from "@cloudflare/workers-types";
import { readPublicCatalog } from "@ren-ai/personas/catalog";
import { catalogLog } from "./catalog-log.ts";

export interface CatalogEnv {
  DB: D1Database;
  PERSONA_CATALOG_URL: string;
}

export async function catalogResponse(request: Request, env: CatalogEnv) {
  const requestId = crypto.randomUUID();
  const start = performance.now();
  const context = {
    service: "discovery",
    requestId,
    method: request.method,
    route: "/api/personas",
    stage: "catalog.read",
  };
  catalogLog({ ...context, event: "request.started", level: "info" });
  let response: Response;
  try {
    if (request.method !== "GET")
      response = new Response(null, { status: 405, headers: { Allow: "GET" } });
    else {
      const origin = new URL(env.PERSONA_CATALOG_URL).origin;
      const url = (path: string) => new URL(path, origin).href;
      const profiles = await readPublicCatalog(env.DB);
      response = Response.json(
        profiles.map((profile) => ({
          ...profile,
          imageUrl: profile.imageUrl ? url(profile.imageUrl) : "",
          ...(profile.portraits && {
            portraits: Object.fromEntries(
              Object.entries(profile.portraits).map(([style, image]) => [style, url(image)]),
            ),
          }),
          secondaryPortraits: profile.secondaryPortraits.map((image) => ({
            ...image,
            imageUrl: url(image.imageUrl),
          })),
        })),
      );
    }
  } catch (cause) {
    const root = cause instanceof Error && cause.cause instanceof Error ? cause.cause : cause;
    catalogLog({
      ...context,
      event: "operation.failed",
      level: "error",
      code: "catalog_unavailable",
      causeName: root instanceof Error ? root.name : "NonError",
      ...(root instanceof Error &&
        "code" in root &&
        typeof root.code === "string" && { causeCode: root.code.slice(0, 80) }),
    });
    response = Response.json({ error: "Catalog is unavailable", requestId }, { status: 503 });
  }
  response.headers.set("X-Request-ID", requestId);
  response.headers.set("Cache-Control", "no-store");
  const failed = response.status >= 500;
  const entry = {
    ...context,
    event: "request.completed",
    level: failed ? ("error" as const) : response.ok ? ("info" as const) : ("warn" as const),
    status: response.status,
    outcome: response.ok ? "completed" : "failed",
    durationMs: Math.round(performance.now() - start),
  };
  catalogLog(entry);
  return response;
}
