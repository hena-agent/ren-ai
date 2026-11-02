import { expect, test, vi } from "vitest";
import { createGateway, type GatewayConfig, type GatewayOptions } from "./gateway.ts";

const config: GatewayConfig = {
  managementToken: "social-management",
  opencodeUrl: "https://opencode.example",
  opencodeAuthorization: "Basic opencode-only",
  imsgUrl: "https://messages.example/rpc",
  imsgToken: "messages-only",
  socialUrl: "http://host.docker.internal:5407",
};
const request = (path: string, method = "POST") =>
  new Request(`https://gateway.example${path}`, {
    method,
    headers: {
      authorization: "Bearer social-management",
      cookie: "private-cookie",
      "x-operation-id": "auth-operation",
      "x-request-id": "untrusted-id",
    },
    ...(method === "POST"
      ? { body: JSON.stringify({ password: "PRIVATE_PASSWORD", code: "PRIVATE_CODE" }) }
      : {}),
  });

test.each(["auth", "runs", "cancel", "open", "browser", "health"])(
  "proxies only the fixed %s route with management auth and no secret logging",
  async (path) => {
    const events: Parameters<NonNullable<GatewayOptions["log"]>>[1][] = [];
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ accepted: true }, { status: 202 }),
    );
    const handler = createGateway({
      config,
      fetcher,
      log: (_level, event) => events.push(event),
      id: () => "gateway-id",
    });
    const input = request(`/social/${path}`, path === "health" ? "GET" : "POST");
    const response = await handler(input.clone());
    expect(response.status).toBe(202);
    const forwarded = new Request(fetcher.mock.calls[0]![0], fetcher.mock.calls[0]![1]);
    expect(forwarded.url).toBe(`http://host.docker.internal:5407/${path}`);
    expect(forwarded.headers.get("authorization")).toBe("Bearer social-management");
    expect(forwarded.headers.get("x-operation-id")).toBe("auth-operation");
    expect(forwarded.headers.get("cookie")).toBeNull();
    expect(forwarded.headers.get("x-request-id")).toBeNull();
    expect(await forwarded.text()).toBe(await input.text());
    expect(response.headers.get("x-request-id")).toBe("gateway-id");
    expect(events.at(-1)).toMatchObject({ operation: "social", outcome: "success" });
    expect(JSON.stringify(events)).not.toMatch(
      /PRIVATE_|private-cookie|untrusted-id|social-management/,
    );
  },
);

test.each([
  "/social/unknown",
  "/social/auth/",
  "/social/%2fauth",
  "/social/auth?url=https://evil.test",
  "/social//auth",
])("rejects unsupported social path %s before forwarding", async (path) => {
  const fetcher = vi.fn<typeof fetch>();
  const handler = createGateway({ config, fetcher, log: () => {} });
  expect((await handler(request(path))).status).toBe(404);
  expect(fetcher).not.toHaveBeenCalled();
});

test("rejects unauthenticated and wrong-method social calls", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const handler = createGateway({ config, fetcher, log: () => {} });
  expect(
    (await handler(new Request("https://gateway.example/social/auth", { method: "POST" }))).status,
  ).toBe(401);
  expect((await handler(request("/social/auth", "GET"))).status).toBe(405);
  expect((await handler(request("/social/health"))).status).toBe(405);
  expect(fetcher).not.toHaveBeenCalled();
});

test.each([
  "https://external.example",
  "http://external.example",
  "http://user:secret@localhost:5407",
  "http://localhost:5407/path",
  "http://localhost:5407?token=secret",
  "http://localhost:5407#secret",
])("forbids external or credential-bearing native origins: %s", (socialUrl) => {
  expect(() => createGateway({ config: { ...config, socialUrl } })).toThrow("local Mac origin");
});

test.each(
  [
    async () => Response.json({ service: "social", revision: "development", status: "ready" }),
    async () => Response.json({ service: "social", revision: "development", status: "degraded" }),
    async () => Response.json({ service: "social", revision: "a".repeat(40), status: "ready" }),
    async () => Response.json({ service: "imsg", revision: "development", status: "ready" }),
    async () => new Response("PRIVATE_BODY", { status: 503 }),
    async () => new Response(null, { status: 503 }),
    async () => new Response("PRIVATE_BODY"),
    async () => {
      throw new Error("PRIVATE_ERROR");
    },
    async () => {
      throw "PRIVATE_THROWN_VALUE";
    },
  ].map((fetcher, index) => ({ fetcher, ready: index === 0 })),
)(
  "gateway health requires a ready native executor at the same artifact revision (%#)",
  async ({ fetcher, ready }) => {
    const events: Parameters<NonNullable<GatewayOptions["log"]>>[1][] = [];
    const handler = createGateway({
      config,
      fetcher,
      health: async () => ({ diskNearlyFull: false, screenLocked: false }),
      log: (_level, event) => events.push(event),
    });
    const response = await handler(new Request("https://gateway.example/health"));
    expect(response.status).toBe(ready ? 200 : 503);
    expect(await response.text()).not.toContain("PRIVATE_");
    const failures = events.filter((event) => event["event"] === "dependency_failure");
    expect(failures).toMatchObject(
      ready
        ? []
        : [
            {
              requestId: response.headers.get("x-request-id"),
              stage: "social.health",
              outcome: "failed",
            },
          ],
    );
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE_|social-management/);
  },
);
