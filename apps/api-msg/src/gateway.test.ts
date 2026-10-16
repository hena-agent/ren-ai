import { describe, expect, it, vi } from "vitest";
import { createGateway, type GatewayConfig, type GatewayOptions } from "./gateway.ts";
import { checkExecutorHealth, nativeCommand } from "./health.ts";
import { createServer } from "node:http";
import { once } from "node:events";
import { gzipSync } from "node:zlib";

const config: GatewayConfig = {
  managementToken: "shared-secret",
  opencodeUrl: "https://oc.test/base",
  opencodeAuthorization: "Basic server-auth",
  imsgUrl: "https://imsg.test/rpc",
  imsgToken: "imsg-secret",
};
const request = (path: string, init: RequestInit = {}) =>
  new Request(`https://gateway.test${path}`, init);
const authorized = { authorization: "Bearer shared-secret" };

it("forwards fetched compressed JSON without stale wire-encoding headers", async () => {
  const payload = { version: "2.0.19" };
  const compressed = gzipSync(JSON.stringify(payload));
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/json",
      "content-encoding": "gzip",
      "content-length": compressed.length,
      connection: "close, x-upstream-only",
      "x-upstream-only": "private-hop",
    });
    response.end(compressed);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("OS port allocation failed");
  try {
    const handler = createGateway({
      config: { ...config, opencodeUrl: `http://127.0.0.1:${address.port}` },
      log: () => {},
    });
    const response = await handler(request("/opencode/api/info", { headers: authorized }));
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("x-upstream-only")).toBeNull();
    expect(await response.json()).toEqual(payload);
  } finally {
    server.close();
    await once(server, "close");
  }
});

it.each(["/health/", "/health/details"])("keeps %s behind authentication", async (path) => {
  const health = vi.fn<NonNullable<GatewayOptions["health"]>>();
  const handler = createGateway({ config, health });
  expect((await handler(request(path))).status).toBe(401);
  expect(health).not.toHaveBeenCalled();
});

describe("authenticated execution gateway", () => {
  it("rejects browser requests before invoking upstream", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const handler = createGateway({ config, fetcher, id: () => "req-1" });
    const response = await handler(request("/opencode/session"));
    expect(response.status).toBe(401);
    expect(response.headers.get("x-request-id")).toBe("req-1");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["wrong-secret", "", "Bearer "])(
    "rejects incorrect or missing credentials",
    async (value) => {
      const handler = createGateway({ config });
      const authorization = value ? `Bearer ${value}` : null;
      const response = await handler(
        request("/imsg/rpc", { headers: authorization ? { authorization } : {} }),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("x-request-id")).toBeTruthy();
    },
  );

  it("rejects blank configured executor tokens", () => {
    expect(() => createGateway({ config: { ...config, managementToken: "  " } })).toThrow(
      "TOKEN_MANAGEMENT must not be blank",
    );
    expect(() => createGateway({ config: { ...config, opencodeAuthorization: " " } })).toThrow(
      "Upstream authorization must not be blank",
    );
  });

  it("accepts configured HTTPS and explicit loopback HTTP URLs only", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    const local = createGateway({
      config: {
        ...config,
        opencodeUrl: "http://127.0.0.1:4701",
        imsgUrl: "http://localhost:4702/rpc",
      },
      fetcher,
    });
    expect((await local(request("/opencode/test", { headers: authorized }))).status).toBe(200);
    expect(() =>
      createGateway({ config: { ...config, opencodeUrl: "http://example.test" } }),
    ).toThrow("Invalid fixed upstream URL");
    expect(() =>
      createGateway({ config: { ...config, opencodeUrl: "https://user:pass@oc.test" } }),
    ).toThrow("Invalid fixed upstream URL");
  });

  it("returns not found for unsupported routes", async () => {
    const handler = createGateway({ config });
    expect((await handler(request("/unknown", { headers: authorized }))).status).toBe(404);
  });

  it("forwards OpenCode path/query to fixed origin and replaces authorization", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    const handler = createGateway({ config, fetcher });
    const response = await handler(
      request("/opencode/session/a%20b?x=1", {
        headers: {
          ...authorized,
          authorization: "Bearer shared-secret",
          "x-request-id": "forged",
          "content-type": "text/plain",
        },
      }),
    );
    const sent = fetcher.mock.calls[0]?.[0];
    expect(new URL(sent instanceof Request ? sent.url : String(sent)).href).toBe(
      "https://oc.test/base/session/a%20b?x=1",
    );
    expect(
      new Headers(sent instanceof Request ? sent.headers : undefined).get("authorization"),
    ).toBe("Basic server-auth");
    expect(
      new Headers(sent instanceof Request ? sent.headers : undefined).get("x-request-id"),
    ).toBeNull();
    expect(response.status).toBe(200);
  });

  it.each([
    "//evil.test/a",
    "/%2f%2fevil.test",
    "/%5c%5cevil.test",
    "/%2e%2e/private",
    "/%252f%252fevil.test",
    "/\\evil.test",
  ])("rejects path tricks %s", async (path) => {
    const fetcher = vi.fn<typeof fetch>();
    const handler = createGateway({ config, fetcher });
    const response = await handler(request(`/opencode${path}`, { headers: authorized }));
    expect([400, 404]).toContain(response.status);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects non-http configured OpenCode targets", () => {
    expect(() => createGateway({ config: { ...config, opencodeUrl: "file:///etc" } })).toThrow(
      "Invalid fixed upstream URL",
    );
  });

  it.each(["/imsg/rpc", "/imsg/rpc/"])(
    "forwards the exact RPC body at %s once with its dedicated bearer credential",
    async (path) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("rpc", { status: 202 }));
      const handler = createGateway({ config, fetcher });
      const response = await handler(
        request(path, {
          method: "POST",
          headers: {
            ...authorized,
            "content-type": "application/json",
            cookie: "private-cookie",
            host: "forged.test",
            connection: "x-remove-me, invalid token",
            "x-remove-me": "hop-value",
          },
          body: '{"private":"payload"}',
        }),
      );
      const sent = fetcher.mock.calls[0]?.[0];
      expect(sent).toBeInstanceOf(Request);
      if (!(sent instanceof Request)) throw new Error("Expected Request");
      expect(sent.url).toBe("https://imsg.test/rpc");
      expect(sent.headers.get("authorization")).toBe("Bearer imsg-secret");
      expect(sent.headers.get("cookie")).toBeNull();
      expect(sent.headers.get("host")).not.toBe("forged.test");
      expect(sent.headers.get("connection")).toBeNull();
      expect(sent.headers.get("x-remove-me")).toBeNull();
      expect(await sent.text()).toBe('{"private":"payload"}');
      expect(response.status).toBe(202);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("streams upstream body and preserves status and cancellation signal", async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode("event: hi\n\n"));
        streamController.close();
      },
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(stream, { status: 206, headers: { "content-type": "text/event-stream" } }),
      );
    const handler = createGateway({ config, fetcher });
    const response = await handler(
      request("/opencode/events", { headers: authorized, signal: controller.signal }),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe("event: hi\n\n");
    const sent = fetcher.mock.calls[0]?.[0];
    expect(sent instanceof Request).toBe(true);
    controller.abort();
    expect(sent instanceof Request && sent.signal.aborted).toBe(true);
  });

  it("returns safe correlated network uncertainty after exactly one side-effect request", async () => {
    const logs: Parameters<NonNullable<GatewayOptions["log"]>>[1][] = [];
    const secret = "private-input-and-secret";
    const failure = Object.assign(new Error(secret), { code: "ECONNRESET" });
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(failure);
    const handler = createGateway({
      config,
      fetcher,
      id: () => "corr-9",
      log: (_level, event) => logs.push(event),
    });
    const response = await handler(
      request("/imsg/rpc", { method: "POST", headers: authorized, body: secret }),
    );
    const data = await response.text();
    expect(response.status).toBe(502);
    expect(data).not.toContain(secret);
    expect(JSON.stringify(logs)).not.toContain(secret);
    expect(JSON.stringify(logs)).toContain("ECONNRESET");
    expect(JSON.stringify(logs)).not.toContain("authorization");
    expect(JSON.stringify(logs)).not.toContain("cookie");
    expect(logs.at(-1)).toMatchObject({
      requestId: "corr-9",
      stage: "upstream",
      outcome: "network_failure",
      cause: "Error",
      code: "ECONNRESET",
    });
    expect(Array.isArray(logs.at(-1)?.["stackFrames"])).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("safely handles non-Error network failures", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue("opaque rejection");
    const handler = createGateway({ config, fetcher });
    const response = await handler(request("/opencode/status", { headers: authorized }));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("opaque rejection");
  });

  it("sanitizes unsafe error names, codes, and payload-bearing stack text", async () => {
    const error = Object.assign(new Error("private prompt"), {
      name: "private prompt",
      code: "secret code",
      stack: "private prompt\nprivate prompt is not a frame",
    });
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(error);
    const events: Parameters<NonNullable<GatewayOptions["log"]>>[1][] = [];
    const handler = createGateway({ config, fetcher, log: (_level, event) => events.push(event) });
    const response = await handler(request("/opencode/status", { headers: authorized }));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("private prompt");
    expect(JSON.stringify(events)).not.toContain("private prompt");
    expect(events.at(-1)).toMatchObject({ cause: "Error", code: "UPSTREAM_NETWORK" });
    expect(events.at(-1)?.["stackFrames"]).toBeUndefined();
  });

  it("preserves upstream HTTP errors and safe request correlation", async () => {
    const events: Parameters<NonNullable<GatewayOptions["log"]>>[1][] = [];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("private upstream body", { status: 503 }));
    const handler = createGateway({
      config,
      fetcher,
      id: () => "http-1",
      log: (_level, event) => events.push(event),
    });
    const response = await handler(request("/opencode/status", { headers: authorized }));
    expect(response.status).toBe(503);
    expect(response.headers.get("x-request-id")).toBe("http-1");
    expect(await response.text()).toBe("private upstream body");
    expect(events.at(-1)).toMatchObject({
      level: "error",
      outcome: "http_failure",
      upstreamStatus: 503,
    });
  });

  it("records upstream client failures as warnings", async () => {
    const events: Parameters<NonNullable<GatewayOptions["log"]>>[1][] = [];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("bad request", { status: 400 }));
    const handler = createGateway({ config, fetcher, log: (_level, event) => events.push(event) });
    expect((await handler(request("/opencode/status", { headers: authorized }))).status).toBe(400);
    expect(events.at(-1)).toMatchObject({
      level: "warn",
      outcome: "http_failure",
      upstreamStatus: 400,
    });
  });

  it("rejects upstream redirects without exposing or following Location", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: "https://other.test/private" } }),
      );
    const events: Parameters<NonNullable<GatewayOptions["log"]>>[1][] = [];
    const handler = createGateway({ config, fetcher, log: (_level, event) => events.push(event) });
    const response = await handler(request("/opencode/status", { headers: authorized }));
    const sent = fetcher.mock.calls[0]?.[0];
    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
    expect(sent instanceof Request && sent.redirect).toBe("manual");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ level: "error", outcome: "redirect_rejected" });
  });

  it("logs correlated safe lifecycle summaries for unexpected paths", async () => {
    const events: Parameters<NonNullable<GatewayOptions["log"]>>[1][] = [];
    const handler = createGateway({
      config,
      id: () => "route-7",
      now: () => 1_800_000_000_000,
      log: (_level, event) => events.push(event),
    });
    const response = await handler(request("/unexpected/private-id", { headers: authorized }));
    expect(response.status).toBe(404);
    expect(response.headers.get("x-request-id")).toBe("route-7");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      service: "api-msg",
      timestamp: new Date(1_800_000_000_000).toISOString(),
      level: "info",
      event: "request_start",
      requestId: "route-7",
    });
    expect(events[1]).toMatchObject({
      level: "warn",
      event: "request_complete",
      stage: "routing",
      outcome: "not_found",
      upstreamStatus: 404,
    });
    expect(JSON.stringify(events)).not.toContain("private-id");
  });

  it("returns correlated method errors with warning summaries", async () => {
    const events: Parameters<NonNullable<GatewayOptions["log"]>>[1][] = [];
    const handler = createGateway({ config, log: (_level, event) => events.push(event) });
    const health = await handler(request("/health", { method: "POST" }));
    const imsg = await handler(request("/imsg/rpc", { headers: authorized }));
    expect(health.status).toBe(405);
    expect(imsg.status).toBe(405);
    expect(health.headers.get("x-request-id")).toBeTruthy();
    expect(imsg.headers.get("x-request-id")).toBeTruthy();
    expect(events.filter((event) => event["outcome"] === "method_not_allowed")).toHaveLength(2);
  });

  it("returns only health facts and records check failures in the response", async () => {
    const facts = { diskNearlyFull: false, screenLocked: true };
    const success = createGateway({ config, health: async () => facts });
    expect(await (await success(request("/health"))).json()).toEqual({
      ...facts,
      service: "api-msg",
      revision: "development",
      status: "degraded",
    });
    const failure = createGateway({
      config,
      health: async () => {
        throw "secret detail";
      },
      id: () => "health-1",
    });
    const failed = await failure(request("/health"));
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("secret detail");
    expect(failed.headers.get("x-request-id")).toBe("health-1");
    const errorFailure = createGateway({
      config,
      health: async () => {
        throw new Error("private");
      },
    });
    expect((await errorFailure(request("/health"))).status).toBe(503);
    const ready = createGateway({
      config,
      health: async () => ({ diskNearlyFull: false, screenLocked: null }),
    });
    const response = await ready(request("/health"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      service: "api-msg",
      revision: "development",
      status: "ready",
    });
    const diskFull = createGateway({
      config,
      health: async () => ({ diskNearlyFull: true, screenLocked: false }),
    });
    expect((await diskFull(request("/health"))).status).toBe(503);
  });

  it("reports native Mac disk and screen checks, failing safely per probe", async () => {
    const run = vi
      .fn<(command: string, args: string[]) => Promise<string>>()
      .mockResolvedValueOnce("disk / 80% ok")
      .mockResolvedValueOnce('"CGSSessionScreenIsLocked"=Yes');
    expect(await checkExecutorHealth(run, "darwin")).toEqual({
      diskNearlyFull: false,
      screenLocked: true,
    });
    expect(run).toHaveBeenNthCalledWith(1, "/bin/df", ["-Pk", "/"]);
    expect(run).toHaveBeenNthCalledWith(2, "/usr/sbin/ioreg", ["-n", "Root", "-d1"]);
    const broken = vi
      .fn<(command: string, args: string[]) => Promise<string>>()
      .mockRejectedValue(new Error("failed"));
    expect(await checkExecutorHealth(broken, "darwin")).toEqual({
      diskNearlyFull: true,
      screenLocked: null,
    });
    expect(await checkExecutorHealth(async () => "Filesystem 90% full", "darwin")).toEqual({
      diskNearlyFull: true,
      screenLocked: false,
    });
    expect(await nativeCommand("/usr/bin/printf", ["native helper works"])).toBe(
      "native helper works",
    );
  });

  it("uses the structured stdout logger by default", async () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("ok")));
    const handler = createGateway({ config });
    await handler(request("/opencode/status", { headers: authorized }));
    expect(write).toHaveBeenCalled();
    vi.unstubAllGlobals();
    write.mockRestore();
  });
});
