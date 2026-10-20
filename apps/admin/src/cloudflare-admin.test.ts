import { expect, test, vi } from "vitest";
import { cloudflareAdmin } from "./cloudflare-admin.ts";
import { memoryStorage } from "../test/memory-storage.ts";
import { cloudflareFixture, databasePersona, adminBindings } from "../test/cloudflare-fixture.ts";
import { character, initialDocuments, portraitImage, request, tokenOf } from "../test/fixtures.ts";
import type { AdminEnv } from "./cloudflare-admin.ts";
import { captureWorkerLogs } from "../test/worker-logs.ts";
import { fromPartial } from "@total-typescript/shoehorn";
import { adminRequest } from "./admin-request.ts";
import { databaseStore } from "./database-store.ts";
import { catalogHandler } from "./catalog-handler.ts";

test.each([false, true])(
  "image delivery is direct R2 in production and local R2 in development (local: %s)",
  async (local) => {
    const { db, bucket } = await cloudflareFixture();
    const { storage } = memoryStorage();
    const { stdout, stderr } = captureWorkerLogs();
    const store = databaseStore(db, bucket, local ? "/images/" : undefined);
    const imageUrl = await store.saveImage(portraitImage);
    const secondary = await store.saveImage(portraitImage);
    await store.save(
      {
        ...databasePersona,
        published: true,
        imageUrl,
        portraits: { photo: imageUrl },
        secondaryPortraits: [{ style: "photo", imageUrl: secondary }],
      },
      initialDocuments,
      { persona: "" },
    );
    const env: AdminEnv = {
      DB: db,
      IMAGES: bucket,
      ASSETS: { fetch: async () => new Response("asset") },
      ADMIN_PASSWORD: "test-password",
      TOKEN_CATALOG: "catalog",
      ...(local && { ADMIN_JURISDICTION: "local" }),
    };
    const admin = await cloudflareAdmin(env, storage);
    const editor = await (await admin.fetch(request(`/personas/${databasePersona.id}`))).text();
    expect(editor).toContain(`src="${imageUrl}"`);
    expect(editor).toContain(`href="${secondary}"`);
    const filename = imageUrl.split("/").at(-1)!;
    expect((await admin.fetch(request(`/images/${filename}`))).status).toBe(local ? 200 : 404);
    expect((await admin.fetch(request(`/discovery/images/${filename}`))).status).toBe(404);
    const publicRequest = request("/api/personas");
    const publicUrl = local ? new URL(imageUrl, publicRequest.url).href : imageUrl;
    const profile = await catalogHandler(publicRequest, env);
    expect(await profile.json()).toMatchObject([
      {
        imageUrl: publicUrl,
        secondaryPortraits: [
          { imageUrl: local ? new URL(secondary, publicRequest.url).href : secondary },
        ],
      },
    ]);
    const catalog = await catalogHandler(
      new Request(new URL("/api/catalog", publicRequest.url), {
        headers: { authorization: "Bearer catalog" },
      }),
      env,
    );
    expect(await catalog.text()).toContain(publicUrl);
    stdout.mockRestore();
    stderr.mockRestore();
  },
);

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
    ...adminBindings(db, bucket),
    GEMINI_API_KEY: "",
    GEMINI_API_URL: "https://provider.test",
    ADMIN_TEXT_MODEL: "text-fixture",
    ADMIN_IMAGE_MODEL: "image-fixture",
  };
  let admin = await cloudflareAdmin(env, storage);
  const token = tokenOf(await (await admin.fetch(request("/new"))).text());
  const registered = await admin.fetch(
    request("/personas", { ...character, draft: token, intent: "sheets" }),
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
        APPLICATION_API_URL: "https://api.renai.im",
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
