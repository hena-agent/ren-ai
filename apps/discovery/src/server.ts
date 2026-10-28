import { Schema } from "effect";
import { BrowsePage, PublicPersona, PersonaLink } from "@ren-ai/onboarding";
import { healthResponse } from "@ren-ai/transport/health";
import { publicResponse, sitemap } from "./public-html.tsx";
import { publicOrigin, publicRoute, previewRoute } from "./public-routing.ts";
import type { SampledPage } from "./public-routing.ts";
import { preferredLocale } from "./locale.tsx";
import { serverCause, writeServerLog } from "./server-log.ts";
import type { ServerEvent } from "./server-log.ts";
import { socialImage } from "./social-image.ts";
import { previewReady, previewResponse } from "./preview-image.ts";
import type { PreviewCache, PreviewEnv } from "./preview-image.ts";

export interface DiscoveryEnv extends PreviewEnv {
  DISCOVERY_API_URL: string;
}
type Failure = (
  cause: ReturnType<typeof serverCause>,
  stage: string,
  upstreamStatus?: number,
) => void;

/** Bound the initial sample wait; failures leave the browser's retryable loading shell. */
async function explorerSample(
  fetcher: typeof fetch,
  request: Request,
  base: string,
  requestId: string,
  failed: Failure,
): Promise<{ people: readonly PublicPersona[]; page: SampledPage } | undefined> {
  if (new URL(request.url).pathname !== "/explore" || request.method !== "GET") return undefined;
  const locale = preferredLocale(
    (request.headers.get("Accept-Language") ?? "")
      .split(",")
      .map((range) => range.replace(/;.*/, "").trim()),
  );
  let stage = "catalog.read";
  let upstreamStatus: number | undefined;
  try {
    const upstream = await fetcher(new URL(`/discovery/personas?locale=${locale}`, base), {
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
      headers: { "X-Request-ID": requestId },
    });
    upstreamStatus = upstream.status;
    if (!upstream.ok) throw new Error("Public Catalog request failed");
    stage = "catalog.decode";
    const { people, nextCursor } = Schema.decodeUnknownSync(BrowsePage)(await upstream.json());
    return { people, page: { locale, nextCursor } };
  } catch (cause) {
    failed(serverCause(cause), stage, upstreamStatus);
    return undefined;
  }
}
function catalogRequest(
  pathname: string,
  id: string | undefined,
  base: string,
  requestId: string,
): [URL, RequestInit] {
  const links = pathname === "/sitemap.xml";
  return [
    new URL(links ? "/discovery/persona-links" : "/discovery/profiles", base),
    {
      ...(!links && { method: "POST", body: JSON.stringify({ ids: id ? [id] : [] }) }),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
      headers: { "X-Request-ID": requestId, "Content-Type": "application/json" },
    },
  ];
}

const failureCodes: Readonly<Record<string, string>> = {
  "catalog.read": "CATALOG_UNAVAILABLE",
  "catalog.decode": "CATALOG_INVALID",
  "image.render": "PREVIEW_UNAVAILABLE",
  "health.preview": "PREVIEW_UNAVAILABLE",
};

function routeResponse(request: Request, url: URL) {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const trimmed = url.pathname.replace(/\/$/, "");
  if (url.pathname.endsWith("/") && publicRoute(new URL(trimmed, url)).id) {
    url.pathname = trimmed;
    return new Response(null, { status: 308, headers: { Location: url.href } });
  }
  if (url.pathname === "/robots.txt")
    return new Response(`User-agent: *\nAllow: /\nSitemap: ${publicOrigin}/sitemap.xml\n`, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  if (url.pathname.startsWith("/personas") && !publicRoute(url).id && !previewRoute(url))
    return new Response("Profile not found", {
      status: 404,
      headers: { "X-Robots-Tag": "noindex" },
    });
  return undefined;
}

function unavailableResponse(path: string, requestId: string, catalogReady: boolean) {
  if (path === "/health")
    return healthResponse("discovery", "degraded", {
      dependencies: {
        catalog: { status: catalogReady ? "ready" : "degraded" },
        preview: { status: "degraded" },
      },
    });
  return new Response(
    `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Ren AI</title></head><body><h1>프로필을 불러오지 못했어요.</h1><p>잠시 후 다시 시도해 주세요.</p><p>Request ID: ${requestId}</p><a href="/explore">다시 불러오기</a></body></html>`,
    {
      status: 503,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "X-Robots-Tag": "noindex",
        "Retry-After": "30",
      },
    },
  );
}

async function servePublic(
  request: Request,
  env: DiscoveryEnv,
  cache: PreviewCache | undefined,
  fetcher: typeof fetch,
  log: (event: ServerEvent) => void,
) {
  const url = new URL(request.url);
  // Home remains a prerendered asset; the explorer samples its first page per visitor.
  const dynamic =
    url.pathname.startsWith("/personas") ||
    ["/explore", "/sitemap.xml", "/robots.txt", "/health"].includes(url.pathname);
  if (!dynamic) return env.ASSETS.fetch(request);
  const requestId = crypto.randomUUID();
  const start = performance.now();
  const imageRoute = previewRoute(url);
  const route = imageRoute ?? publicRoute(url);
  let stage = "route";
  let upstreamStatus: number | undefined;
  let catalogReady = false;
  const fields = {
    requestId,
    operation: "discovery.public" as const,
    ...(route.id && { personaId: route.id }),
    ...(route.style && { style: route.style }),
  };
  const finish = (response: Response) => {
    response.headers.set("X-Request-ID", requestId);
    response.headers.set("Cache-Control", "no-store");
    log({
      ...fields,
      stage: "request",
      outcome: response.status >= 400 ? "failed" : "completed",
      level: response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "info",
      status: response.status,
      durationMs: performance.now() - start,
    });
    return request.method === "HEAD" ? new Response(null, response) : response;
  };
  const failed: Failure = (cause, failedStage, status) =>
    log({
      ...fields,
      stage: failedStage,
      outcome: "failed",
      level: "error",
      code: failureCodes[failedStage] ?? "PAGE_UNAVAILABLE",
      ...cause,
      ...(status !== undefined && { upstreamStatus: status }),
      durationMs: performance.now() - start,
    });
  try {
    const routed = routeResponse(request, url);
    if (routed) return finish(routed);
    const sample = await explorerSample(fetcher, request, env.DISCOVERY_API_URL, requestId, failed);
    let people: readonly PublicPersona[] = sample?.people ?? [];
    if (url.pathname !== "/explore") {
      stage = "catalog.read";
      const upstream = await fetcher(
        ...catalogRequest(url.pathname, route.id, env.DISCOVERY_API_URL, requestId),
      );
      upstreamStatus = upstream.status;
      if (!upstream.ok) throw new Error("Public Catalog request failed");
      stage = "catalog.decode";
      // Decoding strips private or future fields before HTML, bootstrap or metadata can see them.
      if (url.pathname === "/sitemap.xml") {
        const links = Schema.decodeUnknownSync(Schema.Array(PersonaLink))(await upstream.json());
        return finish(
          new Response(sitemap(links), {
            headers: { "Content-Type": "application/xml; charset=utf-8" },
          }),
        );
      }
      people = Schema.decodeUnknownSync(Schema.Array(PublicPersona))(await upstream.json());
      catalogReady = true;
    }
    if (url.pathname === "/health") {
      stage = "health.preview";
      await previewReady(env, url);
      return finish(
        healthResponse("discovery", "ready", {
          dependencies: { catalog: { status: "ready" }, preview: { status: "ready" } },
        }),
      );
    }
    const persona = people.find((person) => person.id === route.id);
    if (imageRoute) {
      stage = "image.render";
      return finish(await previewResponse(url, persona, imageRoute.style, env, cache));
    }
    stage = "assets.template";
    // `template.html`, served without the redirect that `/template.html` would get.
    const template = await env.ASSETS.fetch(new Request(new URL("/template", url)));
    if (!template.ok) throw new Error("Browser template unavailable");
    const image = socialImage(persona, route.style ?? "anime");
    stage = "html.render";
    return finish(publicResponse(await template.text(), people, url, image, sample?.page));
  } catch (cause) {
    failed(serverCause(cause), stage, upstreamStatus);
    return finish(unavailableResponse(url.pathname, requestId, catalogReady));
  }
}

export function discoveryServer(
  fetcher: typeof fetch = fetch,
  log: (event: ServerEvent) => void = writeServerLog,
) {
  return (request: Request, env: DiscoveryEnv, cache?: PreviewCache) =>
    servePublic(request, env, cache, fetcher, log);
}
