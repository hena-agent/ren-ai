import { describe, expect, it, vi } from "vitest";
import { createGateway, type GatewayConfig } from "./gateway.ts";
import { checkMacHealth, nativeCommand } from "./health.ts";

const config: GatewayConfig = {
  executorToken: "shared-secret",
  opencodeUrl: "https://oc.test/base",
  opencodeAuthorization: "Basic server-auth",
  imsgUrl: "https://imsg.test/rpc",
  imsgToken: "imsg-secret",
};
const request = (path: string, init: RequestInit = {}) =>
  new Request(`https://gateway.test${path}`, init);
const authorized = { authorization: "Bearer shared-secret" };

describe("authenticated execution gateway", () => {
  it("rejects browser requests before invoking upstream", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const handler = createGateway({ config, fetcher, id: () => "req-1" });
    const response = await handler(request("/opencode/session"));
    expect(response.status).toBe(401);
    expect(response.headers.get("x-request-id")).toBe("req-1");
    expect(fetcher).not.toHaveBeenCalled();
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
    expect([400, 404]).toContain(
      (await handler(request(`/opencode${path}`, { headers: authorized }))).status,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects non-http configured OpenCode targets", async () => {
    const handler = createGateway({ config: { ...config, opencodeUrl: "file:///etc" } });
    expect((await handler(request("/opencode/status", { headers: authorized }))).status).toBe(400);
  });

  it("forwards the exact imsg RPC body once with its dedicated bearer credential", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("rpc", { status: 202 }));
    const handler = createGateway({ config, fetcher });
    const response = await handler(
      request("/imsg/rpc", {
        method: "POST",
        headers: { ...authorized, "content-type": "application/json" },
        body: '{"private":"payload"}',
      }),
    );
    const sent = fetcher.mock.calls[0]?.[0];
    expect(sent).toBeInstanceOf(Request);
    if (!(sent instanceof Request)) throw new Error("Expected Request");
    expect(sent.url).toBe("https://imsg.test/rpc");
    expect(sent.headers.get("authorization")).toBe("Bearer imsg-secret");
    expect(await sent.text()).toBe('{"private":"payload"}');
    expect(response.status).toBe(202);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

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
    const logs: Record<string, string | number>[] = [];
    const secret = "private-input-and-secret";
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(secret));
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
    expect(logs[0]).toMatchObject({
      requestId: "corr-9",
      stage: "upstream",
      outcome: "network_failure",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("safely handles non-Error network failures", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue("opaque rejection");
    const handler = createGateway({ config, fetcher });
    const response = await handler(request("/opencode/status", { headers: authorized }));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("opaque rejection");
  });

  it("preserves upstream HTTP errors and safe request correlation", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("private upstream body", { status: 503 }));
    const handler = createGateway({ config, fetcher, id: () => "http-1" });
    const response = await handler(request("/opencode/status", { headers: authorized }));
    expect(response.status).toBe(503);
    expect(response.headers.get("x-request-id")).toBe("http-1");
    expect(await response.text()).toBe("private upstream body");
  });

  it("returns only health facts and records check failures in the response", async () => {
    const facts = { diskNearlyFull: false, screenLocked: true };
    const success = createGateway({ config, health: async () => facts });
    expect(await (await success(request("/health", { headers: authorized }))).json()).toEqual(
      facts,
    );
    const failure = createGateway({
      config,
      health: async () => {
        throw "secret detail";
      },
      id: () => "health-1",
    });
    const failed = await failure(request("/health", { headers: authorized }));
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain("secret detail");
    expect(failed.headers.get("x-request-id")).toBe("health-1");
    const errorFailure = createGateway({
      config,
      health: async () => {
        throw new Error("private");
      },
    });
    expect((await errorFailure(request("/health", { headers: authorized }))).status).toBe(500);
  });

  it("reports native Mac disk and screen checks, failing safely per probe", async () => {
    const run = vi
      .fn<(command: string, args: string[]) => Promise<string>>()
      .mockResolvedValueOnce("disk / 80% ok")
      .mockResolvedValueOnce('"CGSSessionScreenIsLocked"=Yes');
    expect(await checkMacHealth(run)).toEqual({ diskNearlyFull: false, screenLocked: true });
    expect(run).toHaveBeenNthCalledWith(1, "/bin/df", ["-Pk", "/"]);
    expect(run).toHaveBeenNthCalledWith(2, "/usr/sbin/ioreg", ["-n", "Root", "-d1"]);
    const broken = vi
      .fn<(command: string, args: string[]) => Promise<string>>()
      .mockRejectedValue(new Error("failed"));
    expect(await checkMacHealth(broken)).toEqual({ diskNearlyFull: true, screenLocked: false });
    expect(await checkMacHealth(async () => "Filesystem 90% full")).toEqual({
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
