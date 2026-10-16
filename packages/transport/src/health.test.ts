import { afterEach, expect, test, vi } from "vitest";
import { buildRevision, healthResponse, parseHealth, probeHealth, verifyHealth } from "./health.ts";

afterEach(() => vi.unstubAllGlobals());
const health = { service: "api-msg", revision: "a".repeat(40), status: "ready" as const };

test("health responses embed identity, use explicit local revisions and cannot override identity through details", async () => {
  vi.stubGlobal("BUILD_REVISION", undefined);
  expect(buildRevision()).toBe("development");
  const local = healthResponse("admin");
  expect(local.status).toBe(200);
  expect(local.headers.get("cache-control")).toBe("no-store");
  expect(await local.json()).toEqual({
    service: "admin",
    revision: "development",
    status: "ready",
  });
  vi.stubGlobal("BUILD_REVISION", health.revision);
  const degraded = healthResponse("api-app", "degraded", { service: "wrong", database: "ready" });
  expect(degraded.status).toBe(503);
  expect(await degraded.json()).toEqual({
    service: "api-app",
    revision: health.revision,
    status: "degraded",
    database: "ready",
  });
});

test("health parsing narrows untrusted responses and excludes extra payload", () => {
  expect(parseHealth({ ...health, private: "private-marker" }, "api-msg", health.revision)).toEqual(
    health,
  );
  expect(parseHealth({ ...health, status: "degraded" }, "api-msg").status).toBe("degraded");
  for (const input of [
    null,
    "private-marker",
    {},
    { service: "wrong" },
    { service: "api-msg" },
    { ...health, revision: 1 },
    { ...health, revision: "private-marker" },
    { ...health, status: "unknown" },
    { service: "api-msg", revision: "development" },
  ])
    expect(() => parseHealth(input, "api-msg")).toThrow("Unexpected service health response");
  expect(() => parseHealth(health, "api-msg", "b".repeat(40))).toThrow("revision");
});

test("deployment verification requires exact identity and distinguishes readiness from identity-only rollout checks", async () => {
  expect(await verifyHealth(Response.json(health), "api-msg", health.revision)).toEqual(health);
  const degraded = { ...health, status: "degraded" };
  expect(
    await verifyHealth(Response.json(degraded, { status: 503 }), "api-msg", health.revision, true),
  ).toEqual(degraded);
  await expect(
    verifyHealth(Response.json(degraded, { status: 503 }), "api-msg", health.revision),
  ).rejects.toThrow("not ready");
  await expect(
    verifyHealth(Response.json(health, { status: 503 }), "api-msg", health.revision),
  ).rejects.toThrow("inconsistent");
  await expect(
    verifyHealth(new Response("private-marker"), "api-msg", health.revision),
  ).rejects.toThrow("identity or revision");
});

test("dependency probes reject wrong servers, auth failures, redirects and private payloads", async () => {
  const fetcher = vi.fn<typeof fetch>();
  expect(await probeHealth("https://executor.test", "api-msg", " ", fetcher)).toEqual({
    status: "unconfigured",
  });
  const probe = () => probeHealth("https://executor.test", "api-msg", "secret-token", fetcher);
  fetcher.mockRejectedValueOnce(new Error("private network payload"));
  expect(await probe()).toEqual({ status: "unreachable" });
  for (const status of [401, 403]) {
    fetcher.mockResolvedValueOnce(new Response(null, { status }));
    expect(await probe()).toEqual({ status: "unauthorized" });
  }
  for (const response of [
    new Response(null, { status: 404 }),
    Response.redirect("https://other.test"),
    new Response("private-marker"),
    Response.json({ ...health, service: "old-api" }),
    Response.json(health, { status: 503 }),
  ]) {
    fetcher.mockResolvedValueOnce(response);
    expect(await probe()).toEqual({ status: "unexpected_response" });
  }
  fetcher.mockResolvedValueOnce(Response.json(health));
  expect(await probe()).toEqual(health);
  fetcher.mockResolvedValueOnce(Response.json({ ...health, status: "degraded" }, { status: 503 }));
  expect((await probe()).status).toBe("degraded");
  expect(fetcher.mock.calls.at(-1)?.[1]?.redirect).toBe("manual");
  expect(fetcher.mock.calls.at(-1)?.[1]?.headers).toEqual({ Authorization: "Bearer secret-token" });
});
