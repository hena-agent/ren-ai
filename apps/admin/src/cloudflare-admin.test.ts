import { expect, test, vi } from "vitest";
import { cloudflareAdmin } from "./cloudflare-admin.ts";
import { memoryStorage } from "../test/memory-storage.ts";
import { cloudflareFixture } from "../test/cloudflare-fixture.ts";
import { character, request, tokenOf } from "../test/fixtures.ts";
import type { AdminEnv } from "./cloudflare-admin.ts";
import { captureWorkerLogs } from "../test/worker-logs.ts";
import { fromPartial } from "@total-typescript/shoehorn";
import { adminRequest } from "./admin-request.ts";

test.each(["empty", "missing"] as const)(
  "the Worker boundary handles %s API key configuration without losing diagnostics or private drafts",
  async (key) => {
    const { db, bucket } = await cloudflareFixture();
    const { storage } = memoryStorage();
    const { stdout, stderr } = captureWorkerLogs();
    const env = fromPartial<AdminEnv>({
      DB: db,
      IMAGES: bucket,
      ADMIN_PASSWORD: "test-password",
      TOKEN_CATALOG: "catalog",
      ...(key === "empty" && { GEMINI_API_KEY: "" }),
      ASSETS: { fetch: async () => new Response("asset") },
    });
    const admin = await cloudflareAdmin(env, storage);
    await admin.alarm();
    const token = tokenOf(await (await admin.fetch(request("/new"))).text());
    const submitted = request("/personas", {
      draft: token,
      seed: "private worker idea",
      gender: "female",
      intent: "character",
    });
    const response = await adminRequest(submitted, () => admin.fetch(submitted));
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const id = response.headers.get("x-request-id")!;
    expect(await response.text()).toContain(id);
    const errors = stderr.mock.calls.map(([line]) => String(line)).join("");
    const lifecycle = stdout.mock.calls.map(([line]) => String(line)).join("");
    expect(errors).toContain(id);
    expect(errors).toContain('"code":"missing_key"');
    expect(errors).toContain('"stage":"generation.api"');
    expect(errors).toContain('"event":"request.completed"');
    expect(lifecycle).toContain('"event":"request.started"');
    for (const secret of ["private worker idea", token, "admin:test-password"])
      expect(errors + lifecycle).not.toContain(secret);
    stdout.mockRestore();
    stderr.mockRestore();
    await expect(
      cloudflareAdmin(
        { ...env, ASSETS: { fetch: async () => new Response(null, { status: 404 }) } },
        storage,
      ),
    ).rejects.toThrow("static asset");
  },
);

test("alarms execute one photo, re-arm remaining work and restore safe failed diagnostics", async () => {
  const { db, bucket } = await cloudflareFixture();
  const { storage, clearAlarm } = memoryStorage();
  const { stdout, stderr } = captureWorkerLogs();
  const env: AdminEnv = {
    DB: db,
    IMAGES: bucket,
    ASSETS: { fetch: async () => new Response("asset") },
    ADMIN_PASSWORD: "test-password",
    TOKEN_CATALOG: "catalog",
    GEMINI_API_KEY: "",
    GEMINI_API_URL: "https://provider.test",
    ADMIN_TEXT_MODEL: "text-fixture",
    ADMIN_IMAGE_MODEL: "image-fixture",
  };
  let admin = await cloudflareAdmin(env, storage);
  const token = tokenOf(await (await admin.fetch(request("/new"))).text());
  const registered = await admin.fetch(
    request("/personas", { ...character, draft: token, intent: "generate" }),
  );
  const url = registered.headers.get("location")!;
  const alarm = await storage.getAlarm();
  expect(alarm).not.toBeNull();
  await admin.fetch(request(url));
  expect(await storage.getAlarm()).toBe(alarm);
  clearAlarm();
  await admin.alarm();
  expect(await storage.getAlarm()).not.toBeNull();
  clearAlarm();
  await admin.alarm();
  expect(await storage.getAlarm()).toBeNull();
  admin = await cloudflareAdmin(env, storage);
  expect((await admin.fetch(request(url))).status).toBe(200);
  const diagnostics = stderr.mock.calls.map(([line]) => String(line)).join("");
  expect(diagnostics).toContain('"model":"image-fixture"');
  expect(diagnostics).toContain('"code":"missing_key"');
  stdout.mockRestore();
  stderr.mockRestore();
});

test("the Worker connects authenticated management pages without exposing its service token", async () => {
  const { db, bucket } = await cloudflareFixture();
  const { storage } = memoryStorage();
  const { stdout, stderr } = captureWorkerLogs();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ entries: [], eligibleCount: 0 }))
    .mockResolvedValueOnce(new Response("private@example.net messaging-secret", { status: 503 }));
  vi.stubGlobal("fetch", fetcher);
  try {
    const admin = await cloudflareAdmin(
      {
        DB: db,
        IMAGES: bucket,
        ASSETS: { fetch: async () => new Response("asset") },
        ADMIN_PASSWORD: "test-password",
        TOKEN_CATALOG: "catalog",
        APPLICATION_API_URL: "https://api-app.renai.im",
        TOKEN_MANAGEMENT: "messaging-secret",
      },
      storage,
    );
    expect((await admin.fetch(request("/waitlist"))).status).toBe(200);
    expect(new Headers(fetcher.mock.calls[0]![1]!.headers).get("authorization")).toBe(
      "Bearer messaging-secret",
    );
    expect((await admin.fetch(request("/first-contacts"))).status).toBe(503);
    const output = [...stdout.mock.calls, ...stderr.mock.calls]
      .map(([line]) => String(line))
      .join("");
    expect(output).not.toContain("messaging-secret");
    expect(output).not.toContain("private@example.net");
  } finally {
    vi.unstubAllGlobals();
    stdout.mockRestore();
    stderr.mockRestore();
  }
});
