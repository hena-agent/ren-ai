import { createServer } from "node:http";
import { once } from "node:events";
import { expect, test } from "vitest";
import { probeExecutor } from "./probe.ts";

const failedFetch: typeof fetch = async () => {
  throw new Error("private-token echoed from an upstream");
};

test("executor probe authenticates a real local health response without exposing its body", async () => {
  const server = createServer((request, response) => {
    if (request.headers.authorization !== "Bearer private-token") {
      response.writeHead(401).end("private-token");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        service: "api-msg",
        revision: "development",
        status: "ready",
        diskNearlyFull: false,
        screenLocked: false,
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("OS port allocation failed");
  try {
    await expect(
      probeExecutor(`http://127.0.0.1:${address.port}`, "private-token"),
    ).resolves.toEqual({ diskNearlyFull: false, screenLocked: false });
    await expect(probeExecutor(`http://127.0.0.1:${address.port}`, "wrong-token")).rejects.toThrow(
      "401",
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});

test.each([
  { status: 503, body: "private response text", expected: "503" },
  { status: 200, body: "{}", expected: "invalid" },
  { status: 200, body: "not-json", expected: "invalid" },
  {
    status: 200,
    body: JSON.stringify({ service: "old-api", revision: "development", status: "ready" }),
    expected: "invalid",
  },
  {
    status: 200,
    body: JSON.stringify({ service: "api-msg", revision: "a".repeat(40), status: "ready" }),
    expected: "invalid",
  },
  {
    status: 200,
    body: JSON.stringify({ service: "api-msg", revision: "development", status: "ready" }),
    expected: "invalid",
  },
  {
    status: 200,
    body: JSON.stringify({ service: "api-msg", revision: "development", status: "degraded" }),
    expected: "invalid",
  },
])("executor probe rejects status $status safely", async ({ status, body, expected }) => {
  const fetcher: typeof fetch = async () => new Response(body, { status });
  await expect(probeExecutor("http://127.0.0.1:4700", "private-token", fetcher)).rejects.toThrow(
    expected,
  );
});

test("executor probe hides network error details", async () => {
  await expect(
    probeExecutor("http://127.0.0.1:4700", "private-token", failedFetch),
  ).rejects.toThrow("health request failed");
});
