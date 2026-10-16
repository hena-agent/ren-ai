import { expect, test, vi } from "vitest";
import { parsePersona, serializePersona } from "@ren-ai/personas";
import { catalogClient } from "./catalog.ts";
const fixturePersona = parsePersona(
  "harin",
  "---\nname: 하린\ntime-zone: Asia/Seoul\nlanguage: ko\nopening-line: Say hello.\nmemory: Keep memories.\n---\nPrivate character instructions.\n\n## 공개 프로필\n\nintro\n",
);

test("public Catalog reads stay fresh and preserve direct image URLs", async () => {
  const owned = "https://persona-images.renai.im/00000000-0000-0000-0000-000000000000.png";
  const external = "https://photos.example.net/photo.jpg";
  const profile = {
    id: "sora",
    name: "Sora",
    bio: "Public introduction",
    imageUrl: owned,
    portraits: { anime: owned, photo: external },
    secondaryPortraits: [{ style: "photo", imageUrl: owned }],
    portraitGallery: [{ anime: owned, photo: external }],
    privatePrompt: "private-marker",
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json([profile]))
    .mockResolvedValueOnce(
      Response.json([profile, { id: "new", name: "New", bio: "New profile", imageUrl: "" }]),
    );
  const client = catalogClient({ url: "http://127.0.0.1:3729", token: "secret" }, fetcher);
  const [first] = await client.publicList();
  const { privatePrompt: _privatePrompt, ...publicProfile } = profile;
  expect(first).toEqual(publicProfile);
  expect(await client.publicList()).toHaveLength(2);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("Catalog requests use separate public/private boundaries and validate every private record", async () => {
  const calls: Request[] = [];
  const connection = { url: "http://127.0.0.1:3729", token: "catalog-secret" };
  const record = fixturePersona;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    const path = new URL(request.url).pathname;
    if (path === "/api/catalog")
      return Response.json({
        revision: "one",
        personas: [
          { id: record.id, source: serializePersona(record), state: "state", memory: "memory" },
        ],
      });
    return Response.json([{ id: record.id, name: "name", bio: "intro", imageUrl: "" }]);
  });
  const client = catalogClient(connection, fetcher);
  expect((await client.load()).personas.get(record.id)?.prompt).toBe(record.prompt);
  expect(calls[0]!.headers.get("authorization")).toBe("Bearer catalog-secret");
  expect(calls[0]!.redirect).toBe("manual");
  expect(await client.publicList()).toHaveLength(1);
  expect(calls[1]!.headers.has("authorization")).toBe(false);
  expect(calls).toHaveLength(2);
});

test("Catalog uses Workers-supported manual redirects without forwarding them to callers", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const client = catalogClient({ url: "https://admin.test", token: "secret" }, fetcher);
  fetcher.mockResolvedValueOnce(Response.redirect("https://other.test/private", 302));
  await expect(client.load()).rejects.toThrow("Catalog request failed (302");
  fetcher.mockResolvedValueOnce(Response.redirect("https://other.test/public", 301));
  await expect(client.publicList()).rejects.toThrow("Catalog request failed (301");
});

test("runtime definitions carry initial documents and absolute R2 image URLs for the existing Discovery client", async () => {
  const owned = "https://persona-images.renai.im/00000000-0000-0000-0000-000000000000.png";
  const record = {
    ...fixturePersona,
    imageUrl: owned,
    portraits: { anime: owned, photo: "https://example.net/photo.jpg" },
    secondaryPortraits: [{ style: "anime" as const, imageUrl: owned }],
  };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      revision: "images",
      personas: [
        {
          id: record.id,
          source: serializePersona(record),
          state: "initial state",
          memory: "initial memory",
        },
      ],
    }),
  );
  const client = catalogClient({ url: "https://admin.test", token: "catalog-secret" }, fetcher);
  const loaded = (await client.load()).personas.get(record.id)!;
  expect(loaded.imageUrl).toBe(owned);
  expect(loaded.portraits).toEqual({
    anime: owned,
    photo: "https://example.net/photo.jpg",
  });
  expect(loaded.secondaryPortraits?.[0]?.imageUrl).toBe(owned);
  expect(loaded.initial).toEqual({ state: "initial state", memory: "initial memory" });
  fetcher.mockResolvedValueOnce(
    Response.json({
      revision: "draft",
      personas: [
        { id: record.id, source: serializePersona(fixturePersona), state: "", memory: "" },
      ],
    }),
  );
  expect((await client.load()).personas.get(record.id)?.initial).toBeUndefined();
  fetcher.mockResolvedValueOnce(
    Response.json({
      revision: "partial",
      personas: [
        {
          id: record.id,
          source: serializePersona(fixturePersona),
          state: "initial state",
          memory: "",
        },
      ],
    }),
  );
  expect((await client.load()).personas.get(record.id)?.initial).toBeUndefined();
});

test("Catalog rejects insecure origins, upstream failures, malformed profiles and duplicate IDs", async () => {
  expect(() => catalogClient({ url: "http://public.example", token: "secret" })).toThrow("HTTPS");
  expect(() =>
    catalogClient({ url: "https://user:credential@admin.test", token: "secret" }),
  ).toThrow("credential-free");
  expect(() => catalogClient({ url: "https://:credential@admin.test", token: "secret" })).toThrow(
    "credential-free",
  );
  for (const url of ["https://admin.test", "http://localhost:3729"])
    expect(catalogClient({ url, token: "secret" })).toBeDefined();
  const fetcher = vi.fn<typeof fetch>();
  const client = catalogClient({ url: "https://admin.test", token: "secret" }, fetcher);
  fetcher.mockResolvedValueOnce(
    new Response("private body", { status: 503, headers: { "x-request-id": "correlation" } }),
  );
  await expect(client.load()).rejects.toThrow("503; request correlation");
  fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }));
  await expect(client.load()).rejects.toThrow("request unavailable");
  fetcher.mockResolvedValueOnce(
    Response.json({
      revision: "x",
      personas: [{ id: "invalid", source: "private payload", state: "", memory: "" }],
    }),
  );
  await expect(client.load()).rejects.toThrow("Invalid private Catalog response");
  const entry = {
    id: fixturePersona.id,
    source: serializePersona(fixturePersona),
    state: "",
    memory: "",
  };
  fetcher.mockResolvedValueOnce(Response.json({ revision: "x", personas: [entry, entry] }));
  await expect(client.load()).rejects.toThrow("Invalid private Catalog response");
  fetcher.mockResolvedValueOnce(Response.json([{ id: "bad", bio: "private payload" }]));
  await expect(client.publicList()).rejects.toThrow("Invalid public Catalog response");
});
