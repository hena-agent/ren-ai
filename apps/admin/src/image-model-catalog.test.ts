import { expect, test, vi } from "vitest";
import { createImageModelCatalog } from "./image-model-catalog.ts";
import {
  modelCatalogFetch,
  modelsDevFixture,
  seedreamModel,
  openaiModel,
  googleModel,
  testImageConnections,
} from "../test/image-models.ts";
import { modelPrice } from "./image-model-pricing.ts";
import { privateTokens } from "./private-token.ts";
import { imageModelId } from "./image-model.ts";
import { fetchUrl } from "../test/fetch-url.ts";
import { deferred } from "../test/queue.ts";
import { nativeSelection } from "./image-model-source.ts";

test("one catalog discovers multiple providers, prices and future model IDs without a code allowlist", async () => {
  const data = modelsDevFixture();
  data["openai"]!.models["brand-new-2030"] = {
    ...data["openai"]!.models[openaiModel.model]!,
    id: "brand-new-2030",
    name: "Future Image",
    release_date: "2030-01-01",
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation((url, init) =>
      fetchUrl(url).includes("models.dev")
        ? Promise.resolve(Response.json(data))
        : modelCatalogFetch(url, init),
    );
  const catalog = createImageModelCatalog(testImageConnections, "secret", fetcher);
  const page = await catalog.list("", null, false);
  expect(new Set(page.models.map((model) => model.provider))).toEqual(
    new Set(["openai", "google", "openrouter", "fal"]),
  );
  expect(page.models[0]!.name).toBe("Future Image");
  const choice = await catalog.resolve("openai:brand-new-2030");
  expect(choice.model).toBe("brand-new-2030");
  expect(choice.price).toContain("0.04 / image");
  expect(catalog.selected(catalog.quote(choice), choice.id)).toEqual(choice);
  expect(JSON.stringify(page)).not.toContain("openai-key");
  await catalog.list("Future", null, false);
  expect(fetcher.mock.calls.filter(([url]) => fetchUrl(url).includes("models.dev"))).toHaveLength(
    1,
  );
  await catalog.list("", null, true);
  expect(fetcher.mock.calls.filter(([url]) => fetchUrl(url).includes("models.dev"))).toHaveLength(
    2,
  );
});

test("disconnected, deprecated, text-only reference and unexpected API-address entries cannot be selected", async () => {
  const data = modelsDevFixture();
  data["openai"]!.models[openaiModel.model]!.api.images.base_url = "https://attacker.test";
  data["google"]!.models[googleModel.model]!.modalities.input = ["text"];
  const deprecated = { ...data["openrouter"]!.models["vendor/new-image"]!, status: "deprecated" };
  const payload = {
    ...data,
    openrouter: { ...data["openrouter"]!, models: { "vendor/new-image": deprecated } },
    other: { name: "Unconnected", models: data["openai"]!.models },
  };
  const fetcher: typeof fetch = async (url, init) =>
    fetchUrl(url).includes("models.dev") ? Response.json(payload) : modelCatalogFetch(url, init);
  const catalog = createImageModelCatalog({ ...testImageConnections, fal: "" }, "secret", fetcher);
  const page = await catalog.list("", null, false);
  expect(page.models.every((model) => Boolean(model.reason))).toBe(true);
  await expect(catalog.resolve(openaiModel.id)).rejects.toThrow("API 주소");
  await expect(catalog.resolve(googleModel.id)).rejects.toThrow("참조 이미지");
  await expect(catalog.resolve("openrouter:vendor/new-image")).rejects.toThrow("지원 종료");
  await expect(catalog.resolve("other:gpt-image-new")).rejects.toThrow("공급자");
  await expect(catalog.resolve(seedreamModel.id)).rejects.toThrow("FAL_KEY");
});

test("signed selection rejects tampering and model substitution before any paid request", async () => {
  const catalog = createImageModelCatalog(testImageConnections, "secret", modelCatalogFetch);
  const selection = await catalog.resolve(openaiModel.id);
  expect(() => catalog.selected("tampered", selection.id)).toThrow("폼 데이터");
  expect(() => catalog.selected(catalog.quote(selection), googleModel.id)).toThrow("일치");
  expect(() => catalog.selected(catalog.quote(selection), null)).toThrow("선택");
  const tokens = privateTokens("secret");
  expect(() => catalog.selected(tokens.encode('{"id":"bad"}'), selection.id)).toThrow(
    "Invalid image model selection",
  );
  expect(() =>
    catalog.selected(
      tokens.encode(JSON.stringify({ ...selection, id: "openai:other" })),
      "openai:other",
    ),
  ).toThrow("일치");
  await expect(catalog.resolve("invalid")).rejects.toThrow("카탈로그");
  await expect(catalog.resolve("openai:not-in-catalog")).rejects.toThrow("카탈로그");
  expect(() => imageModelId("openai", "../escape")).toThrow("identifier");
  expect(() => imageModelId("openai", "x/../escape")).toThrow("identifier");
  expect(() => imageModelId("bad provider", "model")).toThrow("identifier");
  expect(imageModelId("cloudflare-workers-ai", "@cf/vendor/image")).toBe(
    "cloudflare-workers-ai:@cf/vendor/image",
  );
});

test("independent source failures stay visible while another provider's catalog remains available", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (url, init) =>
      fetchUrl(url).includes("models.dev")
        ? new Response("unavailable", { status: 503 })
        : modelCatalogFetch(url, init),
    );
  const catalog = createImageModelCatalog(testImageConnections, "secret", fetcher);
  const page = await catalog.list("", null, false);
  expect(page.errors).toHaveLength(1);
  expect(page.models.every((model) => model.provider === "fal")).toBe(true);
  const reverse = vi
    .fn<typeof fetch>()
    .mockImplementation(async (url, init) =>
      fetchUrl(url).includes("models.dev")
        ? modelCatalogFetch(url, init)
        : new Response("unavailable", { status: 503 }),
    );
  const nativeOnly = await createImageModelCatalog(testImageConnections, "secret", reverse).list(
    "",
    null,
    false,
  );
  expect(nativeOnly.errors).toHaveLength(1);
  expect(nativeOnly.models).toHaveLength(3);
});

test("price units remain modality-specific and absent prices are never displayed as free", () => {
  expect(modelPrice(undefined)).toContain("무료를 뜻하지");
  expect(modelPrice({ image: {} })).toContain("단가 정보 없음");
  expect(modelPrice({ text: { input: { price: 1 } } })).toContain("100만 token");
  expect(
    modelPrice({
      image: {
        input: { price: 0.01, unit: "megapixel", overrides: [{}] },
        output: { price: 0.02, unit: "image" },
      },
    }),
  ).toContain("옵션별 요금");
});

test("raster output formats, missing dates and disconnected providers remain accurate", async () => {
  const payload = modelsDevFixture();
  const base = payload["openai"]!.models[openaiModel.model]!;
  const { release_date: _date, ...withoutDate } = base;
  const source = {
    ...payload,
    openai: {
      ...payload["openai"]!,
      models: {
        jpeg: {
          ...withoutDate,
          id: "jpeg",
          modalities: { input: ["image"], output: ["image/jpeg"] },
        },
        webp: { ...base, id: "webp", modalities: { input: ["image"], output: ["image/webp"] } },
        vector: {
          ...base,
          id: "vector",
          modalities: { input: ["image"], output: ["image/svg+xml"] },
        },
        noapi: { ...base, id: "noapi", api: {} },
      },
    },
  };
  const fetcher: typeof fetch = async (url, init) =>
    fetchUrl(url).includes("models.dev") ? Response.json(source) : modelCatalogFetch(url, init);
  const page = await createImageModelCatalog(
    { ...testImageConnections, openai: "" },
    "secret",
    fetcher,
  ).list("", null, false);
  expect(page.models.find((model) => model.model === "jpeg")).toMatchObject({
    outputFormat: "jpeg",
    releaseDate: "",
    reason: "공급자 API 키 미연결",
  });
  expect(page.models.find((model) => model.model === "webp")!.outputFormat).toBe("webp");
  expect(page.models.some((model) => model.model === "vector")).toBe(false);
});

test("failed metadata responses are not retained as successful catalog entries", async () => {
  let fail = true;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (fail) return new Response("not-json");
    return modelCatalogFetch(url, init);
  });
  const catalog = createImageModelCatalog(testImageConnections, "secret", fetcher);
  const failed = await catalog.list("", null, false);
  expect(failed.models).toHaveLength(0);
  expect(failed.errors).toHaveLength(2);
  fail = false;
  expect((await catalog.list("", null, false)).models.length).toBeGreaterThan(0);
});

test("contract caches are bounded and expired metadata is reloaded", async () => {
  const data = modelsDevFixture();
  const provider = data["openai"]!;
  for (let index = 0; index < 52; index++)
    provider.models[`future-${index}`] = {
      ...provider.models[openaiModel.model]!,
      id: `future-${index}`,
    };
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (url, init) =>
      fetchUrl(url).includes("models.dev") ? Response.json(data) : modelCatalogFetch(url, init),
    );
  try {
    const catalog = createImageModelCatalog(testImageConnections, "secret", fetcher);
    const first = await catalog.resolve("openai:future-0");
    for (let index = 1; index < 52; index++) await catalog.resolve(`openai:future-${index}`);
    expect(await catalog.resolve("openai:future-0")).not.toBe(first);
    clock.mockReturnValue(302_000);
    await catalog.resolve("openai:future-0");
    expect(fetcher.mock.calls.filter(([url]) => fetchUrl(url).includes("models.dev"))).toHaveLength(
      2,
    );
  } finally {
    clock.mockRestore();
  }
});

test("an older failed catalog load cannot evict a successful explicit refresh", async () => {
  const old = deferred<Response>();
  let reads = 0;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (fetchUrl(url).includes("models.dev")) {
      reads++;
      if (reads === 1) return old.promise;
    }
    return modelCatalogFetch(url, init);
  });
  const catalog = createImageModelCatalog(testImageConnections, "secret", fetcher);
  const first = catalog.list("", null, false);
  expect((await catalog.list("", null, true)).errors).toEqual([]);
  old.resolve(new Response("old request failed", { status: 503 }));
  expect((await first).errors).toHaveLength(1);
  expect((await catalog.list("", null, false)).errors).toEqual([]);
  expect(reads).toBe(2);
});

test("future overlapping fal metadata is deduplicated and native GenerateContent declarations are understood", async () => {
  const data = modelsDevFixture();
  const google = data["google"]!.models[googleModel.model]!;
  const payload = {
    ...data,
    google: {
      ...data["google"]!,
      models: {
        [googleModel.model]: {
          ...google,
          api: {
            "generate-content": { base_url: "https://generativelanguage.googleapis.com/v1beta/" },
          },
        },
      },
    },
    fal: {
      name: "Common fal metadata",
      models: {
        [seedreamModel.model]: {
          ...data["openai"]!.models[openaiModel.model]!,
          id: seedreamModel.model,
        },
      },
    },
  };
  const fetcher: typeof fetch = async (url, init) =>
    fetchUrl(url).includes("models.dev") ? Response.json(payload) : modelCatalogFetch(url, init);
  const catalog = createImageModelCatalog(testImageConnections, "secret", fetcher);
  const page = await catalog.list("", null, false);
  expect(page.models.filter((model) => model.id === seedreamModel.id)).toHaveLength(1);
  expect(page.models.find((model) => model.id === seedreamModel.id)!.providerName).toBe("fal");
  expect((await catalog.resolve(googleModel.id)).provider).toBe("google");
});

test("native selection cannot accidentally enable an unsupported provider even without a disabled reason", async () => {
  const catalog = createImageModelCatalog(testImageConnections, "secret", modelCatalogFetch);
  const entry = (await catalog.list("", null, false)).models.find(
    (model) => model.id === openaiModel.id,
  )!;
  expect(() => nativeSelection({ ...entry, provider: "unimplemented", reason: "" })).toThrow(
    "공급자",
  );
});
