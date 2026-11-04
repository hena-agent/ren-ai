import { afterEach, expect, test, vi } from "vitest";
import { fromPartial } from "@total-typescript/shoehorn";
import type { R2Bucket, R2ObjectBody, R2Object } from "@cloudflare/workers-types";
import * as provider from "@ren-ai/image-generation";
import { socialImageBackend } from "./social/image-backend.ts";
import type { catalogClient } from "./personas/catalog.ts";

afterEach(() => vi.restoreAllMocks());
const bytes = new Uint8Array([255, 216, 255, 254, 0, 2, 255, 217]);
function fixture() {
  const objects = new Map<string, Uint8Array>();
  const bucket = fromPartial<R2Bucket>({
    get: async (key: string) => {
      const data = objects.get(key);
      return data
        ? fromPartial<R2ObjectBody>({ arrayBuffer: async () => Uint8Array.from(data).buffer })
        : null;
    },
    put: async (key: string, value: Parameters<R2Bucket["put"]>[1]) => {
      if (!(value instanceof Uint8Array)) throw new Error("Unexpected fixture data");
      objects.set(key, value);
      return fromPartial<R2Object>({ key });
    },
    delete: async (key: string | string[]) => {
      if (typeof key !== "string") throw new Error("Unexpected fixture key");
      objects.delete(key);
    },
  });
  const catalog = fromPartial<ReturnType<typeof catalogClient>>({
    load: async () => ({
      revision: "rev",
      personas: new Map([
        [
          "alice",
          {
            id: "alice",
            prompt: "PRIVATE_DESCRIPTION",
            memory: "memory",
            openingLine: "hello",
            language: "ko",
            timeZone: "Asia/Seoul",
            sheets: {},
          },
        ],
      ]),
    }),
    sheet: vi.fn<ReturnType<typeof catalogClient>["sheet"]>(async () => ({
      bytes,
      mimeType: "image/jpeg",
    })),
  });
  const env = {
    PERSONA_CATALOG_URL: "https://catalog.test",
    API_MSG_URL: "https://gateway.test",
    CODEX_IMAGE_API_KEY: "PRIVATE_KEY",
    CONVERSATION_PHOTOS: bucket,
  };
  const generate = vi.spyOn(provider, "codexImage").mockImplementation(async (input) => {
    await input.beforeDispatch?.();
    return { bytes: Buffer.from(bytes), mimeType: "image/jpeg" };
  });
  const api = socialImageBackend(env, catalog, fetch)!;
  return { api, env, catalog, generate, objects };
}
test.each(["self", "creation"] as const)(
  "public %s images reuse the generation provider and only self images use the identity sheet",
  async (kind) => {
    const f = fixture();
    let dispatched = 0;
    expect(
      await f.api.generate({
        personaId: "alice",
        kind,
        style: "photo",
        scene: "PRIVATE_SCENE",
        beforeDispatch: async () => {
          dispatched++;
        },
      }),
    ).toEqual(Buffer.from(bytes));
    const request = f.generate.mock.calls[0]![0];
    expect(request.references).toHaveLength(kind === "self" ? 1 : 0);
    expect(request.prompt).toContain("AI-created self-expression");
    expect(request.prompt.includes("Do not depict the Persona")).toBe(kind === "creation");
    expect(dispatched).toBe(1);
    await f.api.put("draft", bytes);
    expect(f.objects.has("social-images/draft.jpg")).toBe(true);
    expect(f.objects.has("conversation-photos/draft.jpg")).toBe(false);
    expect(await f.api.get("draft")).toEqual(bytes);
    await f.api.remove("draft");
    expect(await f.api.get("draft")).toBeUndefined();
  },
);
test("missing configuration, Persona or identity reference never reaches paid dispatch", async () => {
  const f = fixture();
  expect(
    socialImageBackend({ ...f.env, CODEX_IMAGE_API_KEY: "" }, f.catalog, fetch),
  ).toBeUndefined();
  expect(
    socialImageBackend(
      { PERSONA_CATALOG_URL: "https://catalog.test", API_MSG_URL: "https://gateway.test" },
      f.catalog,
      fetch,
    ),
  ).toBeUndefined();
  await expect(
    f.api.generate({
      personaId: "missing",
      kind: "self",
      style: "anime",
      scene: "scene",
      beforeDispatch: async () => {
        throw new Error("must not dispatch");
      },
    }),
  ).rejects.toMatchObject({ code: "SOCIAL_PERSONA_NOT_FOUND" });
  vi.mocked(f.catalog.sheet).mockResolvedValue(undefined);
  await expect(
    f.api.generate({
      personaId: "alice",
      kind: "self",
      style: "anime",
      scene: "scene",
      beforeDispatch: async () => {
        throw new Error("must not dispatch");
      },
    }),
  ).rejects.toMatchObject({ code: "SOCIAL_IDENTITY_SHEET_REQUIRED" });
  expect(f.generate).not.toHaveBeenCalled();
});

test("the selected anime direction is passed to the existing provider", async () => {
  const f = fixture();
  await f.api.generate({
    personaId: "alice",
    kind: "creation",
    style: "anime",
    scene: "creative scene",
    beforeDispatch: async () => {},
  });
  expect(f.generate.mock.calls[0]![0].prompt).toContain("Anime illustration");
});
