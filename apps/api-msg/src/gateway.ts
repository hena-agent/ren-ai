import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { healthResponse as serviceHealth } from "@ren-ai/transport/health";
import { checkExecutorHealth, type ExecutorHealth } from "./health.ts";

export type GatewayConfig = {
  managementToken: string;
  opencodeUrl: string;
  opencodeAuthorization: string;
  imsgUrl: string;
  imsgToken: string;
};
type Level = "info" | "warn" | "error";
type LogFields = Record<string, string | number | string[]>;
export type GatewayOptions = {
  config: GatewayConfig;
  fetcher?: typeof fetch;
  health?: () => Promise<ExecutorHealth>;
  log?: (level: Level, event: LogFields) => void;
  now?: () => number;
  id?: () => string;
};

const headerToken = (value: string | null) => {
  const match = /^Bearer (.+)$/i.exec(value ?? "");
  return match?.[1] ?? "";
};

const authorized = (header: string | null, expected: string) => {
  const actualDigest = createHash("sha256").update(headerToken(header)).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
};

const configuredUrl = (input: string) => {
  const url = new URL(input);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw new Error("Invalid fixed upstream URL");
  }
  return url;
};

const target = (base: URL, path: string, search: string): URL | null => {
  if (/%25|%2f|%5c|%2e/i.test(path) || path.includes("\\") || path.startsWith("//")) return null;
  return new URL(`${base.origin}${base.pathname.replace(/\/$/, "")}${path}${search}`);
};

const safeErrorNames = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "DOMException",
  "FetchError",
  "SocketError",
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "RequestAbortedError",
]);

export const safeError = (error: Error, code: string) => {
  const safeName = safeErrorNames.has(error.name) ? error.name : "Error";
  const errorCode = "code" in error && typeof error.code === "string" ? error.code : code;
  const safeCode = /^[A-Z][A-Z0-9_]{0,63}$/.test(errorCode) ? errorCode : code;
  const stackFrames = error.stack
    ?.split("\n")
    .slice(1)
    .filter((line) => /^\s+at\s+[\w.$<>]+\s+\(.+:\d+:\d+\)$/.test(line))
    .slice(0, 8)
    .map((line) => line.trim().slice(0, 200));
  return { cause: safeName, code: safeCode, ...(stackFrames?.length ? { stackFrames } : {}) };
};

export const logEvent = (level: Level, event: LogFields) => {
  (level === "info" ? process.stdout : process.stderr).write(`${JSON.stringify(event)}\n`);
};

const stripHopByHop = (headers: Headers) => {
  const nominated = (headers.get("connection") ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => /^[a-z0-9!#$%&'*+.^_`|~-]+$/i.test(name));
  for (const name of [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    ...nominated,
  ])
    headers.delete(name);
};

export const createGateway = (options: GatewayOptions) => {
  const config = options.config;
  if (!config.managementToken.trim()) throw new Error("TOKEN_MANAGEMENT must not be blank");
  if (!config.opencodeAuthorization.trim() || !config.imsgToken.trim()) {
    throw new Error("Upstream authorization must not be blank");
  }
  const opencodeUrl = configuredUrl(config.opencodeUrl);
  const imsgUrl = configuredUrl(config.imsgUrl);
  const fetcher = options.fetcher ?? fetch;
  const health = options.health ?? checkExecutorHealth;
  const now = options.now ?? Date.now;
  const id = options.id ?? randomUUID;
  const log = options.log ?? logEvent;
  const emit = (level: Level, fields: LogFields) =>
    log(level, { service: "api-msg", timestamp: new Date(now()).toISOString(), level, ...fields });

  return async (request: Request): Promise<Response> => {
    const requestId = id();
    const started = now();
    const url = new URL(request.url);
    const op = operation(url.pathname);
    const common = { requestId, operation: op };
    emit("info", {
      ...common,
      event: "request_start",
      stage: "request",
      outcome: "started",
      durationMs: 0,
      upstreamStatus: 0,
    });
    const finish = (
      stage: string,
      outcome: string,
      status: number,
      level: Level,
      error?: Error,
    ) => {
      emit(level, {
        ...common,
        event: "request_complete",
        stage,
        outcome,
        durationMs: now() - started,
        upstreamStatus: status,
        ...(error
          ? safeError(error, stage === "upstream" ? "UPSTREAM_NETWORK" : "HEALTH_CHECK_FAILED")
          : {}),
      });
    };
    const complete = (
      response: Response,
      stage: string,
      outcome: string,
      level: Level,
      error?: Error,
    ) => {
      finish(stage, outcome, response.status, level, error);
      const headers = new Headers(response.headers);
      headers.set("x-request-id", requestId);
      if (url.pathname === "/health") headers.set("Cache-Control", "no-store");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    };

    if (url.pathname === "/health") {
      if (request.method !== "GET")
        return complete(
          new Response("Method not allowed", { status: 405 }),
          "routing",
          "method_not_allowed",
          "warn",
        );
      return healthResponse(health, requestId, complete);
    }
    if (!authorized(request.headers.get("authorization"), config.managementToken)) {
      return complete(new Response("Unauthorized", { status: 401 }), "auth", "rejected", "warn");
    }
    const isOpenCode = url.pathname.startsWith("/opencode/");
    const isImsg = op === "imsg";
    if (isImsg && request.method !== "POST") {
      return complete(
        new Response("Method not allowed", { status: 405 }),
        "routing",
        "method_not_allowed",
        "warn",
      );
    }
    if (!isOpenCode && !isImsg) {
      return complete(new Response("Not found", { status: 404 }), "routing", "not_found", "warn");
    }
    const destination = isOpenCode
      ? target(opencodeUrl, url.pathname.slice("/opencode".length), url.search)
      : imsgUrl;
    if (destination === null) {
      return complete(
        new Response("Invalid path", { status: 400 }),
        "routing",
        "invalid_path",
        "warn",
      );
    }
    const headers = new Headers(request.headers);
    stripHopByHop(headers);
    for (const name of ["host", "authorization", "cookie", "x-request-id"]) headers.delete(name);
    headers.set(
      "authorization",
      isOpenCode ? config.opencodeAuthorization : `Bearer ${config.imsgToken}`,
    );
    const body = request.method === "GET" || request.method === "HEAD" ? null : request.body;
    return forward(fetcher, request, destination, headers, body, complete);
  };
};

const operation = (path: string) => {
  if (path.startsWith("/opencode/")) return "opencode";
  if (path === "/imsg/rpc" || path === "/imsg/rpc/") return "imsg";
  if (path === "/health") return "health";
  return "routing";
};

type Complete = (
  response: Response,
  stage: string,
  outcome: string,
  level: Level,
  error?: Error,
) => Response;

const healthResponse = async (
  health: () => Promise<ExecutorHealth>,
  requestId: string,
  complete: Complete,
) => {
  try {
    const facts = await health();
    const ready = !facts.diskNearlyFull && !facts.screenLocked;
    return complete(
      serviceHealth("api-msg", ready ? "ready" : "degraded", facts),
      "health",
      ready ? "success" : "degraded",
      ready ? "info" : "warn",
    );
  } catch (error) {
    const cause = error instanceof Error ? error : new Error("UnknownError");
    return complete(
      serviceHealth("api-msg", "degraded", {
        error: "Health check failed",
        requestId,
      }),
      "health",
      "failure",
      "error",
      cause,
    );
  }
};

const forward = async (
  fetcher: typeof fetch,
  request: Request,
  destination: URL,
  headers: Headers,
  body: ReadableStream<Uint8Array> | null,
  complete: Complete,
) => {
  try {
    const upstream = await fetcher(
      new Request(destination, {
        method: request.method,
        headers,
        body,
        redirect: "manual",
        ...(body ? { duplex: "half" as const } : {}),
        signal: request.signal,
      }),
    );
    if ([301, 302, 303, 307, 308].includes(upstream.status)) {
      await upstream.body?.cancel();
      return complete(
        Response.json({ error: "Upstream redirects are not allowed" }, { status: 502 }),
        "upstream",
        "redirect_rejected",
        "error",
      );
    }
    const level: Level =
      upstream.status >= 500 ? "error" : upstream.status >= 400 ? "warn" : "info";
    const outcome = upstream.status >= 400 ? "http_failure" : "success";
    const responseHeaders = new Headers(upstream.headers);
    stripHopByHop(responseHeaders);
    // Fetch already decodes the body; the upstream's wire metadata no longer applies.
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
    return complete(
      new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      }),
      "upstream",
      outcome,
      level,
    );
  } catch (error) {
    const cause = error instanceof Error ? error : new Error("UnknownError");
    return complete(
      Response.json(
        { error: "Upstream outcome is uncertain", ...safeError(cause, "UPSTREAM_NETWORK") },
        { status: 502 },
      ),
      "upstream",
      "network_failure",
      "error",
      cause,
    );
  }
};
