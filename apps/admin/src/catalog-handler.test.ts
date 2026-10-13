import { expect, test, vi } from "vitest";
import { catalogHandler } from "./catalog-handler.ts";
import type { AdminEnv } from "./cloudflare-admin.ts";
import { cloudflareFixture, databasePersona } from "../test/cloudflare-fixture.ts";
import { initialDocuments, portraitImage } from "../test/fixtures.ts";

test("Catalog HTTP separates public profiles and images from the authenticated atomic private snapshot", async () => {
  const { db, bucket, store } = await cloudflareFixture();
  const env: AdminEnv = {
    DB: db,
    IMAGES: bucket,
    ASSETS: { fetch: async () => new Response("") },
    ADMIN_PASSWORD: "password",
    TOKEN_CATALOG: "catalog-secret",
    GEMINI_API_KEY: "",
  };
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const call = (path: string, init?: RequestInit, bindings = env) =>
    catalogHandler(new Request(`https://admin.test${path}`, init), bindings);
  expect((await call("/api/personas", { method: "POST" })).status).toBe(405);
  expect((await call("/api/catalog")).status).toBe(401);
  expect((await call("/api/catalog", { headers: { authorization: "Bearer wrong" } })).status).toBe(
    401,
  );
  expect(
    (
      await call(
        "/api/catalog",
        { headers: { authorization: "Bearer " } },
        { ...env, TOKEN_CATALOG: "" },
      )
    ).status,
  ).toBe(401);
  const imageUrl = await store.saveImage(portraitImage);
  await store.save(
    { ...databasePersona, published: true, imageUrl, portraits: { photo: imageUrl } },
    initialDocuments,
    { persona: "" },
  );
  const publicResponse = await call("/api/personas");
  expect(publicResponse.status).toBe(200);
  const publicBody = await publicResponse.text();
  expect(publicBody).not.toContain("비공개");
  expect((await call(imageUrl)).status).toBe(200);
  expect((await call("/discovery/images/not-owned.png")).status).toBe(404);
  const privateResponse = await call("/api/catalog", {
    headers: { authorization: "Bearer catalog-secret" },
  });
  const privateBody = await privateResponse.text();
  expect(privateBody).toContain("비공개");
  expect(privateBody).toContain("state");
  expect(
    (
      await call("/api/catalog", {
        headers: {
          authorization: "Bearer catalog-secret",
          "if-none-match": privateResponse.headers.get("etag")!,
        },
      })
    ).status,
  ).toBe(304);
  await db.exec("DROP TABLE persona_images");
  const failed = await call("/api/catalog", {
    headers: { authorization: "Bearer catalog-secret" },
  });
  expect(failed.status).toBe(503);
  expect(await failed.text()).toContain(failed.headers.get("x-request-id")!);
  const diagnostics = stderr.mock.calls.map(([line]) => String(line)).join("");
  expect(diagnostics).toContain('"code":"database_error"');
  expect(diagnostics).toContain('"causeName":');
  expect(diagnostics).not.toContain("비공개");
  expect(diagnostics).not.toContain("catalog-secret");
  stdout.mockRestore();
  stderr.mockRestore();
});
