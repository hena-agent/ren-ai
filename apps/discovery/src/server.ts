import { Schema } from "effect";
import { PublicPersona } from "@ren-ai/onboarding";
import { healthResponse } from "@ren-ai/transport/health";
import { publicResponse, sitemap } from "./public-html.tsx";
import { publicOrigin, publicRoute } from "./public-routing.ts";
import { serverCause, writeServerLog } from "./server-log.ts";
import type { ServerEvent } from "./server-log.ts";
import { socialImage, brandSocialImage } from "./social-image.ts";

interface DiscoveryEnv {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  DISCOVERY_API_URL: string;
}

const failureCodes: Readonly<Record<string, string>> = {
  "catalog.read": "CATALOG_UNAVAILABLE",
  "catalog.decode": "CATALOG_INVALID",
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
  if (url.pathname.startsWith("/personas") && !publicRoute(url).id)
    return new Response("Profile not found", {
      status: 404,
      headers: { "X-Robots-Tag": "noindex" },
    });
  return undefined;
}

export function discoveryServer(
  fetcher: typeof fetch = fetch,
  log: (event: ServerEvent) => void = writeServerLog,
) {
  return async (request: Request, env: DiscoveryEnv) => {
    const url = new URL(request.url);
    const dynamic =
      url.pathname.startsWith("/personas") ||
      ["/", "/explore", "/sitemap.xml", "/robots.txt", "/health"].includes(url.pathname);
    if (!dynamic) return env.ASSETS.fetch(request);
    const requestId = crypto.randomUUID();
    const start = performance.now();
    const route = publicRoute(url);
    let stage = "route";
    let upstreamStatus: number | undefined;
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
    try {
      const routed = routeResponse(request, url);
      if (routed) return finish(routed);
      let people: readonly PublicPersona[] = [];
      if (url.pathname !== "/") {
        stage = "catalog.read";
        const upstream = await fetcher(new URL("/discovery/personas", env.DISCOVERY_API_URL), {
          cache: "no-store",
          signal: AbortSignal.timeout(8_000),
          headers: { "X-Request-ID": requestId },
        });
        upstreamStatus = upstream.status;
        if (!upstream.ok) throw new Error("Public Catalog request failed");
        stage = "catalog.decode";
        // Decoding strips private or future fields before HTML, bootstrap or metadata can see them.
        people = Schema.decodeUnknownSync(Schema.Array(PublicPersona))(await upstream.json());
      }
      if (url.pathname === "/health")
        return finish(
          healthResponse("discovery", "ready", { dependencies: { catalog: { status: "ready" } } }),
        );
      if (url.pathname === "/sitemap.xml")
        return finish(
          new Response(sitemap(people), {
            headers: { "Content-Type": "application/xml; charset=utf-8" },
          }),
        );
      stage = "assets.template";
      const template = await env.ASSETS.fetch(new Request(new URL("/index.html", url)));
      if (!template.ok) throw new Error("Browser template unavailable");
      const image =
        request.method === "HEAD"
          ? brandSocialImage
          : await socialImage(
              people.find((person) => person.id === route.id),
              route.style ?? "anime",
              fetcher,
              (error, imageStage, status) =>
                log({
                  ...fields,
                  stage: imageStage,
                  outcome: "failed",
                  level: "warn",
                  code: "SOCIAL_IMAGE_UNAVAILABLE",
                  ...serverCause(error),
                  ...(status !== undefined && { upstreamStatus: status }),
                  durationMs: performance.now() - start,
                }),
            );
      stage = "html.render";
      return finish(publicResponse(await template.text(), people, url, image));
    } catch (cause) {
      log({
        ...fields,
        stage,
        outcome: "failed",
        level: "error",
        code: failureCodes[stage] ?? "PAGE_UNAVAILABLE",
        ...serverCause(cause),
        ...(upstreamStatus !== undefined && { upstreamStatus }),
        durationMs: performance.now() - start,
      });
      if (url.pathname === "/health")
        return finish(
          healthResponse("discovery", "degraded", {
            dependencies: { catalog: { status: "degraded" } },
          }),
        );
      return finish(
        new Response(
          `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Ren AI</title></head><body><h1>프로필을 불러오지 못했어요.</h1><p>잠시 후 다시 시도해 주세요.</p><p>Request ID: ${requestId}</p><a href="/explore">다시 불러오기</a></body></html>`,
          {
            status: 503,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "X-Robots-Tag": "noindex",
              "Retry-After": "30",
            },
          },
        ),
      );
    }
  };
}
