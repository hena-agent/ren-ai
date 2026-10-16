import { expect, test, vi } from "vitest";
import { applicationTransport } from "./application-transport.ts";

test("initialization and transport failure retain correlation and safe cause without request data", async () => {
  const request = new Request("https://app.example", {
    headers: { Authorization: "Bearer private-credential" },
  });
  const ok = new Response("ready");
  expect(await applicationTransport(request, async () => ok)).toBe(ok);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    const response = await applicationTransport(request, () =>
      Promise.reject(
        Object.assign(new Error("private-credential sensitive-data-marker"), {
          code: "DB_UNAVAILABLE",
        }),
      ),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Application is unavailable",
      requestId: response.headers.get("x-request-id"),
    });
    const health = await applicationTransport(
      new Request("https://app.example/health"),
      async () => {
        throw new Error("private initialization failure");
      },
    );
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({
      service: "api-app",
      revision: "development",
      status: "degraded",
      application: "unavailable",
      requestId: health.headers.get("x-request-id"),
    });
    const logs = JSON.stringify(stderr.mock.calls);
    expect(logs).toContain("DB_UNAVAILABLE");
    expect(logs).not.toContain("private-credential");
    expect(logs).not.toContain("sensitive-data-marker");
  } finally {
    stderr.mockRestore();
  }
});

test("health reports the edge artifact revision separately from a Durable Object on an older code version", async () => {
  const health = await applicationTransport(new Request("https://app.example/health"), async () =>
    Response.json({
      service: "api-app",
      revision: "a".repeat(40),
      status: "ready",
      database: "ready",
      storage: "durable-object-sqlite",
      bootstrapOnly: false,
      executor: { service: "api-msg", revision: "a".repeat(40), status: "ready" },
    }),
  );
  expect(health.status).toBe(503);
  expect(await health.json()).toEqual({
    service: "api-app",
    revision: "development",
    status: "degraded",
    database: "ready",
    storage: "durable-object-sqlite",
    bootstrapOnly: false,
    executor: { service: "api-msg", revision: "a".repeat(40), status: "ready" },
    applicationRuntime: { revision: "a".repeat(40), status: "outdated" },
  });
});

test.each([
  ["ready", 200],
  ["degraded", 503],
] as const)(
  "edge identity retains matching Durable Object readiness (%s)",
  async (status, expectedStatus) => {
    const response = await applicationTransport(
      new Request("https://app.example/health"),
      async () =>
        Response.json(
          {
            service: "api-app",
            revision: "development",
            status,
            database: "ready",
            storage: "durable-object-sqlite",
            bootstrapOnly: false,
            executor: { service: "api-msg", status: "ready" },
          },
          { status: expectedStatus },
        ),
    );
    expect(response.status).toBe(expectedStatus);
    expect(await response.json()).toMatchObject({
      revision: "development",
      status,
      applicationRuntime: { revision: "development", status: "ready" },
    });
  },
);

test("a malformed Durable Object health response stays degraded without echoing its payload", async () => {
  const response = await applicationTransport(new Request("https://app.example/health"), async () =>
    Response.json({ service: "private-marker", revision: "sensitive-marker", status: "ready" }),
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    service: "api-app",
    revision: "development",
    status: "degraded",
    applicationRuntime: { status: "unavailable" },
  });
});
