// @vitest-environment node
import { expect, test, vi } from "vitest";
import { fromPartial } from "@total-typescript/shoehorn";
import type { D1Database } from "@cloudflare/workers-types";
import { withPublicProfile } from "@ren-ai/personas/profile";
import { readPublicCatalog } from "@ren-ai/personas/catalog";
import { catalogResponse } from "./catalog-response.ts";
import { catalogFixture } from "../test/catalog-fixture.ts";
import { Schema } from "effect";
import { PublicPersona } from "@ren-ai/onboarding";

const url = "https://discovery.example/api/personas";
const key = "01234567-89ab-cdef-0123-456789abcdef.png";

test("D1 lists only published profiles in one query, retaining partial styles and ordered extra photos", async () => {
  const fixture = await catalogFixture();
  const source = withPublicProfile(
    "private persona source",
    "안녕하세요.\n\n### 취향\n\n산책을 좋아해요.",
  );
  await fixture.persona("both", source);
  await fixture.persona("anime", source);
  await fixture.persona("empty", source);
  await fixture.persona("draft", "private draft", false);
  await fixture.photo("both", key, "photo", 0);
  await fixture.photo("both", `1${key.slice(1)}`, "anime", 0);
  await fixture.photo("both", `2${key.slice(1)}`, "photo", 1);
  await fixture.photo("anime", key, "anime", 0);
  const spy = vi.fn<D1Database["prepare"]>().mockImplementation((sql) => fixture.db.prepare(sql));
  const profiles = await readPublicCatalog({ prepare: spy });
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0]![0]).not.toMatch(/p\.state|p\.memory/);
  expect(profiles.map((profile) => profile.id)).toEqual(["anime", "both", "empty"]);
  expect(profiles[0]!.imageUrl).toBe(`/discovery/images/${key}`);
  expect(profiles[1]!.secondaryPortraits).toEqual([
    { style: "photo", imageUrl: `/discovery/images/2${key.slice(1)}` },
  ]);
  expect(profiles[2]).not.toHaveProperty("portraits");
  const info = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const response = await catalogResponse(new Request(url), {
    DB: fixture.db,
    PERSONA_CATALOG_URL: "https://admin.example/path",
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const data = Schema.decodeUnknownSync(Schema.Array(PublicPersona))(await response.json());
  expect(data).toMatchObject([
    { imageUrl: `https://admin.example/discovery/images/${key}` },
    {
      portraits: { photo: `https://admin.example/discovery/images/${key}` },
      secondaryPortraits: [{ imageUrl: `https://admin.example/discovery/images/2${key.slice(1)}` }],
    },
    { imageUrl: "" },
  ]);
  const serialized = JSON.stringify(data);
  for (const secret of [
    "private persona source",
    "private draft",
    "private state",
    "private memory",
    "private instruction",
    "private opening",
  ])
    expect(serialized).not.toContain(secret);
  const requestId = response.headers.get("x-request-id")!;
  expect(info.mock.calls.map(([entry]) => String(entry))).toEqual([
    expect.stringContaining(`"requestId":"${requestId}"`),
    expect.stringContaining('"event":"request.completed"'),
  ]);
  expect(String(info.mock.calls[1]![0])).toContain('"status":200');
  expect(String(info.mock.calls[1]![0])).toContain(`"requestId":"${requestId}"`);
  vi.restoreAllMocks();
});

test("a database failure is a correlated 503, never an empty catalog or payload-bearing diagnostic", async () => {
  const error = new Error("private SQL text and secret credential");
  Object.assign(error, { code: "SQLITE_ERROR" });
  const wrapped = new Error("private wrapper", { cause: error });
  const db = fromPartial<D1Database>({
    prepare: () => {
      throw wrapped;
    },
  });
  const info = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const errors = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const response = await catalogResponse(new Request(url), {
    DB: db,
    PERSONA_CATALOG_URL: "https://admin.example",
  });
  expect(response.status).toBe(503);
  const requestId = response.headers.get("x-request-id")!;
  expect(await response.json()).toEqual({ error: "Catalog is unavailable", requestId });
  expect(errors.mock.calls).toHaveLength(2);
  for (const [entry] of errors.mock.calls)
    expect(String(entry)).toContain(`"requestId":"${requestId}"`);
  expect(String(errors.mock.calls[0]![0])).toContain('"causeCode":"SQLITE_ERROR"');
  expect(String(errors.mock.calls[0]![0])).toContain('"stage":"catalog.read"');
  expect(String(errors.mock.calls[1]![0])).toContain('"status":503');
  expect(JSON.stringify([...info.mock.calls, ...errors.mock.calls])).not.toContain("private");
  vi.restoreAllMocks();
});

test("method failures and invalid provider responses stay explicit and exclude input from logs", async () => {
  const fixture = await catalogFixture();
  const info = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const errors = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const env = { DB: fixture.db, PERSONA_CATALOG_URL: "https://admin.example" };
  const method = await catalogResponse(new Request(url, { method: "POST" }), env);
  expect(method.status).toBe(405);
  expect(method.headers.get("allow")).toBe("GET");
  expect(errors).toHaveBeenCalledTimes(1);
  expect(String(errors.mock.calls[0]![0])).toContain('"level":"warn"');
  expect(
    (await catalogResponse(new Request(url), { ...env, PERSONA_CATALOG_URL: "bad" })).status,
  ).toBe(503);
  const statement = fromPartial<ReturnType<D1Database["prepare"]>>({
    all: async () => {
      throw "private non-error";
    },
  });
  const db = fromPartial<D1Database>({ prepare: () => statement });
  expect((await catalogResponse(new Request(url), { ...env, DB: db })).status).toBe(503);
  await fixture.persona("malformed", "private\n\n## 공개 프로필\n\nhello\n\n## secret");
  expect((await catalogResponse(new Request(url), env)).status).toBe(503);
  expect(JSON.stringify([...info.mock.calls, ...errors.mock.calls])).not.toContain("private");
  vi.restoreAllMocks();
});
