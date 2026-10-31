import { Schema } from "effect";
import { BrowsePage, PublicPersona, PersonaLink } from "@ren-ai/onboarding";
import { healthResponse } from "@ren-ai/transport/health";
import { publicResponse, sitemap } from "./public-html.tsx";
import {
  publicOrigin,
  publicRoute,
  previewRoute,
  localizedPath,
  localePreferenceCookie,
} from "./public-routing.ts";
import type { SampledPage } from "./public-routing.ts";
import { requestLocale } from "./request-locale.ts";
import { serverCause, writeServerLog } from "./server-log.ts";
import type { ServerEvent } from "./server-log.ts";
import { previewReady, previewResponse } from "./preview-image.ts";
import type { PreviewCache, PreviewEnv } from "./preview-image.ts";
import { messages } from "./locale.tsx";

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
  const route = publicRoute(new URL(request.url));
  if (route.path !== "/explore" || request.method !== "GET") return undefined;
  const locale = route.locale ?? requestLocale(request);
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
  const route = publicRoute(url);
  const trimmed = new URL(url);
  trimmed.pathname = url.pathname.replace(/\/$/, "") || "/";
  const page = publicRoute(trimmed);
  if (page.path === "/" || page.path === "/explore" || page.id) {
    const locale = page.locale ?? requestLocale(request);
    const target = localizedPath(page.path, locale);
    if (url.pathname !== target) {
      url.pathname = target;
      return new Response(null, {
        status: page.locale ? 308 : 307,
        headers: {
          Location: url.href,
          ...(!page.locale && { Vary: "Accept-Language, Cookie" }),
          ...(page.locale === "en" && { "Set-Cookie": localePreferenceCookie("en") }),
        },
      });
    }
  }
  if (url.pathname === "/robots.txt")
    return new Response(`User-agent: *\nAllow: /\nSitemap: ${publicOrigin}/sitemap.xml\n`, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  if (
    route.locale
      ? route.path !== "/" && route.path !== "/explore" && !route.id
      : url.pathname.startsWith("/personas") && !route.id && !previewRoute(url)
  )
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
  const { locale = "en" } = publicRoute(new URL(path, publicOrigin));
  const copy = messages[locale];
  return new Response(
    `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>RenAI</title></head><body><h1>${copy.loadFailure}</h1><p>Request ID: ${requestId}</p><a href="${localizedPath("/explore", locale)}">${copy.retry}</a></body></html>`,
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
  const imageRoute = previewRoute(url);
  const route = { ...publicRoute(url), ...imageRoute };
  const dynamic =
    Boolean(route.locale) ||
    url.pathname.startsWith("/personas") ||
    ["/", "/explore", "/explore/", "/sitemap.xml", "/robots.txt", "/health"].includes(url.pathname);
  if (!dynamic) return env.ASSETS.fetch(request);
  const requestId = crypto.randomUUID();
  const start = performance.now();
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
    if (
      !route.locale &&
      !imageRoute &&
      (route.path === "/" || route.path === "/explore" || route.id)
    )
      response.headers.set("Vary", "Accept-Language, Cookie");
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
    // The prerendered English home remains static after the Worker negotiates its locale.
    if (url.pathname === "/") {
      const asset = await env.ASSETS.fetch(request);
      // Binding responses have immutable headers; preserve the asset in a mutable response.
      const home = new Response(asset.body, asset);
      home.headers.set("Content-Language", "en");
      return finish(home);
    }
    const sample = await explorerSample(fetcher, request, env.DISCOVERY_API_URL, requestId, failed);
    let people: readonly PublicPersona[] = sample?.people ?? [];
    if (route.path !== "/" && route.path !== "/explore") {
      stage = "catalog.read";
      const upstream = await fetcher(
        ...catalogRequest(url.pathname, route.id, env.DISCOVERY_API_URL, requestId),
      );
      upstreamStatus = upstream.status;
      if (!upstream.ok) throw new Error("Public Catalog request failed");
      stage = "catalog.decode";
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
    const template = await env.ASSETS.fetch(new Request(new URL("/template", url)));
    if (!template.ok) throw new Error("Browser template unavailable");
    stage = "html.render";
    return finish(publicResponse(await template.text(), people, url, sample?.page));
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
