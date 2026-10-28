import { expect, test, vi } from "vitest";
import { catalogHandler } from "./catalog-handler.ts";
import { rebuildProjections } from "./projection-rebuild.ts";
import type { AdminEnv } from "./cloudflare-admin.ts";
import { cloudflareFixture, databasePersona } from "../test/cloudflare-fixture.ts";
import { initialDocuments, portraitImage } from "../test/fixtures.ts";
import { withPublicProfile } from "@ren-ai/personas/profile";

const fixture = async () => {
  const resources = await cloudflareFixture();
  const env: AdminEnv = {
    DB: resources.db,
    IMAGES: resources.bucket,
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
      description: withPublicProfile(
        databasePersona.description!,
        "안녕하세요. **하린**이에요.\n\n### 기본 정보\n- 직업: 도예가\n\n### 관심사\n- 재즈\n\n### 문답: 완벽한 일요일은?\n책방에 가요.",
      ),
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
      profile: {
        introduction: "안녕하세요. 하린이에요.",
        sections: [
          {
            type: "basics",
            title: "기본 정보",
            items: [{ key: "occupation", label: "직업", value: "도예가" }],
          },
          { type: "interests", title: "관심사", items: ["재즈"] },
          { type: "prompt", question: "완벽한 일요일은?", answer: "책방에 가요." },
        ],
      },
    },
  ]);
  await db.exec("DELETE FROM persona_images");
  const updated = await read();
  expect(updated.status).toBe(200);
  const profiles = await updated.text();
  expect(JSON.parse(profiles)).toMatchObject([{ id: databasePersona.id, imageUrl: "" }]);
  expect(profiles).not.toContain('"portraits"');
  for (const privateField of ["비공개", "publicProfile", "###", "**", '"state"', '"memory"'])
    expect(profiles).not.toContain(privateField);
  await db
    .prepare("UPDATE persona_versions SET markdown = ? WHERE personaId = ? AND version = 1")
    .bind(
      withPublicProfile(databasePersona.description!, "소개.\n\n### 기본 정보\n도예가로 일해요."),
      databasePersona.id,
    )
    .run();
  await rebuildProjections(db);
  const prose = await read();
  expect(prose.status).toBe(200);
  expect(await prose.json()).toMatchObject([
    { profile: { sections: [{ type: "text", title: "기본 정보", body: "도예가로 일해요." }] } },
  ]);
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

test("private sheets use committed persona/style associations, change the snapshot and stay out of public profiles", async () => {
  const { store, env, db, bucket } = await fixture();
  const first = await store.saveImage(portraitImage);
  const second = await store.saveImage(portraitImage);
  await store.save(
    { ...databasePersona, published: true, imageUrl: first, portraits: { photo: first } },
    initialDocuments,
    { persona: "" },
  );
  const before = await store.catalog();
  await store.saveSheet("harin", "anime", second);
  const after = await store.catalog();
  expect(after.revision).not.toBe(before.revision);
  expect(after.personas[0]!.sheets).toEqual({ anime: second.split("/").at(-1) });
  expect(JSON.stringify(after.personas[0]!.persona)).not.toContain(second.split("/").at(-1));
  const read = (query: string, token = "catalog-secret") =>
    catalogHandler(
      new Request(`https://admin.test/api/catalog/sheet?${query}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      env,
    );
  expect((await read("id=harin&style=anime", "wrong")).status).toBe(401);
  for (const query of ["style=anime", "id=../harin&style=anime", "id=harin&style=other"])
    expect((await read(query)).status).toBe(400);
  for (const query of ["id=other&style=anime", "id=harin&style=photo"])
    expect((await read(query)).status).toBe(404);
  const image = await read("id=harin&style=anime");
  expect(image.status).toBe(200);
  expect(image.headers.get("cache-control")).toBe("no-store");
  expect(image.headers.get("content-type")).toBe(portraitImage.mimeType);
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array(portraitImage.bytes));
  expect(
    await (await catalogHandler(new Request("https://admin.test/api/personas"), env)).text(),
  ).not.toContain(second.split("/").at(-1));
  await bucket.put(second.split("/").at(-1)!, new Uint8Array(20_000_001), {
    httpMetadata: { contentType: "image/png" },
  });
  expect((await read("id=harin&style=anime")).status).toBe(503);
  await db
    .prepare("UPDATE persona_identity_sheets SET objectKey = ? WHERE personaId = ?")
    .bind("../foreign.png", "harin")
    .run();
  expect((await read("id=harin&style=anime")).status).toBe(503);
  expect(
    (
      await catalogHandler(
        new Request("https://admin.test/api/catalog/other", {
          headers: { authorization: "Bearer catalog-secret" },
        }),
        env,
      )
    ).status,
  ).toBe(404);
});
