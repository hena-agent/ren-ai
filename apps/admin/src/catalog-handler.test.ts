import { expect, test, vi } from "vitest";
import { catalogHandler } from "./catalog-handler.ts";
import type { AdminEnv } from "./cloudflare-admin.ts";
import { cloudflareFixture, databasePersona } from "../test/cloudflare-fixture.ts";
import { initialDocuments, portraitImage } from "../test/fixtures.ts";

const fixture = async () => {
  const resources = await cloudflareFixture();
  const env: AdminEnv = {
    DB: resources.db,
    IMAGES: resources.bucket,
    ASSETS: { fetch: async () => new Response("") },
    ADMIN_PASSWORD: "password",
    TOKEN_CATALOG: "catalog-secret",
    GEMINI_API_KEY: "",
  };
  return { ...resources, env };
};

test("public Catalog reads current image associations, including anime-only and imageless records", async () => {
  const { db, store, env } = await fixture();
  const imageUrl = await store.saveImage(portraitImage);
  const secondary = await store.saveImage(portraitImage);
  await store.save(
    {
      ...databasePersona,
      published: true,
      imageUrl,
      portraits: { anime: imageUrl },
      secondaryPortraits: [{ style: "anime", imageUrl: secondary }],
    },
    initialDocuments,
    { persona: "" },
  );
  const read = () => catalogHandler(new Request("https://admin.test/api/personas"), env);
  const first = await read();
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject([
    {
      id: databasePersona.id,
      imageUrl,
      portraits: { anime: imageUrl },
      secondaryPortraits: [{ style: "anime", imageUrl: secondary }],
    },
  ]);
  await db.exec("DELETE FROM persona_images");
  const updated = await read();
  expect(updated.status).toBe(200);
  const profiles = await updated.text();
  expect(JSON.parse(profiles)).toMatchObject([{ id: databasePersona.id, imageUrl: "" }]);
  expect(profiles).not.toContain('"portraits"');
});

test("Catalog HTTP separates public profiles from the authenticated atomic private snapshot", async () => {
  const { db, store, env } = await fixture();
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
  expect(publicBody).toContain(imageUrl);
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
