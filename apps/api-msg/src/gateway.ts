import { randomUUID } from "node:crypto";
import { checkMacHealth, type MacHealth } from "./health.ts";

export type GatewayConfig = {
  executorToken: string;
  opencodeUrl: string;
  opencodeAuthorization: string;
  imsgUrl: string;
  imsgToken: string;
};
export type GatewayOptions = {
  config: GatewayConfig;
  fetcher?: typeof fetch;
  health?: () => Promise<MacHealth>;
  log?: (level: "info" | "warn" | "error", event: Record<string, string | number>) => void;
  now?: () => number;
  id?: () => string;
};

const safeError = (error: Error, code: string) => ({
  cause: error.name.slice(0, 80),
  code,
});

const target = (base: string, path: string, search: string): URL | null => {
  if (/%25|%2f|%5c|%2e/i.test(path) || path.includes("\\") || path.startsWith("//")) return null;
  const root = new URL(base);
  if (root.protocol !== "https:" && root.protocol !== "http:") return null;
  const result = new URL(`${root.origin}${root.pathname.replace(/\/$/, "")}${path}${search}`);
  return result;
};

export const createGateway = (options: GatewayOptions) => {
  const fetcher = options.fetcher ?? fetch;
  const health = options.health ?? checkMacHealth;
  const log =
    options.log ??
    ((level, event) => {
      const line = JSON.stringify(event);
      (level === "info" ? process.stdout : process.stderr).write(`${line}\n`);
    });
  const now = options.now ?? Date.now;
  const id = options.id ?? randomUUID;

  return async (request: Request): Promise<Response> => {
    const requestId = id();
    const started = now();
    const url = new URL(request.url);
    const unauthorized =
      request.headers.get("authorization") !== `Bearer ${options.config.executorToken}`;
    if (unauthorized) {
      log("warn", {
        requestId,
        operation: "authentication",
        stage: "auth",
        outcome: "rejected",
        durationMs: now() - started,
        upstreamStatus: 0,
      });
      return new Response("Unauthorized", { status: 401, headers: { "x-request-id": requestId } });
    }
    const finish = (
      stage: string,
      outcome: string,
      status = 0,
      level: "info" | "warn" | "error" = "info",
      cause?: string,
    ) => {
      const error =
        cause === undefined
          ? {}
          : safeError(
              new Error(cause),
              stage === "upstream" ? "UPSTREAM_NETWORK" : "HEALTH_CHECK_FAILED",
            );
      log(level, {
        requestId,
        operation: url.pathname.startsWith("/opencode/") ? "opencode" : url.pathname,
        stage,
        outcome,
        durationMs: now() - started,
        upstreamStatus: status,
        ...error,
      });
    };

    if (url.pathname === "/health" && request.method === "GET") {
      return healthResponse(health, requestId, finish);
    }

    const isOpenCode = url.pathname.startsWith("/opencode/");
    const isImsg = url.pathname === "/imsg/rpc";
    if (!isOpenCode && !isImsg)
      return new Response("Not found", { status: 404, headers: { "x-request-id": requestId } });
    const destination = isOpenCode
      ? target(options.config.opencodeUrl, url.pathname.slice("/opencode".length), url.search)
      : new URL(options.config.imsgUrl);
    if (destination === null)
      return new Response("Invalid path", { status: 400, headers: { "x-request-id": requestId } });
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("authorization");
    headers.set(
      "authorization",
      isOpenCode ? options.config.opencodeAuthorization : `Bearer ${options.config.imsgToken}`,
    );
    headers.delete("x-request-id");
    let body: ReadableStream<Uint8Array> | null = null;
    if (request.method !== "GET" && request.method !== "HEAD") body = request.body;
    return forward(fetcher, request, destination, headers, body, requestId, finish);
  };
};

type Finish = (
  stage: string,
  outcome: string,
  status?: number,
  level?: "info" | "warn" | "error",
  cause?: string,
) => void;

const healthResponse = async (
  health: () => Promise<MacHealth>,
  requestId: string,
  finish: Finish,
) => {
  try {
    const facts = await health();
    finish("health", "success");
    return Response.json(facts, { headers: { "x-request-id": requestId } });
  } catch (error) {
    const cause = error instanceof Error ? error : new Error("UnknownError");
    finish("health", "failure", 0, "error", cause.name);
    return Response.json(
      { error: "Health check failed", requestId, cause: safeError(cause, "HEALTH_CHECK_FAILED") },
      { status: 500, headers: { "x-request-id": requestId } },
    );
  }
};

const forward = async (
  fetcher: typeof fetch,
  request: Request,
  destination: URL,
  headers: Headers,
  body: ReadableStream<Uint8Array> | null,
  requestId: string,
  finish: Finish,
) => {
  try {
    const upstream = await fetcher(
      new Request(destination, {
        method: request.method,
        headers,
        body,
        redirect: "manual",
        duplex: body ? "half" : undefined,
        signal: request.signal,
      } as RequestInit),
    );
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.set("x-request-id", requestId);
    finish("upstream", "success", upstream.status);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    const cause = error instanceof Error ? error : new Error("UnknownError");
    finish("upstream", "network_failure", 0, "error", cause.name);
    return Response.json(
      {
        error: "Upstream outcome is uncertain",
        requestId,
        ...safeError(cause, "UPSTREAM_NETWORK"),
      },
      { status: 502, headers: { "x-request-id": requestId } },
    );
  }
};
