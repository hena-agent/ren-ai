import { afterEach, expect, test, vi } from "vitest";
import { createProfileGenerator } from "./generation.ts";
import { character, png, portraitImage, photoPortrait } from "../test/fixtures.ts";
import { withSeedingBudget } from "./seeding-budget.ts";
import { cloudflareFixture } from "../test/cloudflare-fixture.ts";

afterEach(() => vi.restoreAllMocks());
const reply = () => Response.json({ data: [{ b64_json: png.toString("base64") }] });
const client = (fetcher: typeof fetch, arenaKey = "arena-secret") =>
  createProfileGenerator({
    key: "gemini-secret",
    imageProvider: "arena",
    arenaKey,
    fetcher,
  });

test.each([200, 307])(
  "Arena request options work in workerd and reject redirects (HTTP %i)",
  async (status) => {
    const { runtime } = await cloudflareFixture(
      undefined,
      `export default {
    async fetch(input) {
      const { url, init } = await input.json();
      const request = new Request(url, init);
      if (request.redirect !== "manual") return new Response("Redirects must not be followed", {status: 500});
      return Response.json({data: [{b64_json: ${JSON.stringify(png.toString("base64"))}}]}, {status: ${status}});
    }
  }`,
    );
    const worker = await runtime.getWorker("assets");
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const response = await worker.fetch("http://worker.test/", {
        method: "POST",
        body: JSON.stringify({
          url,
          init: {
            method: init!.method,
            headers: init!.headers,
            body: init!.body,
            redirect: init!.redirect,
          },
        }),
      });
      return new Response(await response.text(), { status: response.status });
    });
    const result = await Promise.allSettled([client(fetcher).sheet(character, "anime")]);
    const expected =
      status === 200
        ? { status: "fulfilled", value: portraitImage }
        : { status: "rejected", reason: { fields: { status: 307, code: "http_error" } } };
    expect(result).toMatchObject([expected]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

test("Arena generates independent sheets and sends same-style identity and composition as data-URI references", async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply());
  const generator = client(fetcher);
  expect(await generator.sheet(character, "anime")).toEqual(portraitImage);
  await generator.sheet(character, "photo", "sheet direction", photoPortrait);
  await generator.portrait(character, "photo", "photo direction", portraitImage, photoPortrait);
  const requests = fetcher.mock.calls.map((args) => new Request(...args));
  expect(requests.map((request) => request.url)).toEqual([
    "https://gpt-image.renai.im/v1/images/generations",
    "https://gpt-image.renai.im/v1/images/edits",
    "https://gpt-image.renai.im/v1/images/edits",
  ]);
  for (const request of requests) {
    expect(request.headers.get("authorization")).toBe("Bearer arena-secret");
    expect(request.headers.has("x-goog-api-key")).toBe(false);
    expect(request.redirect).toBe("manual");
  }
  expect(await requests[0]!.json()).toMatchObject({
    model: "gpt-image-2.5-sunburst",
    n: 1,
    size: "1536x1024",
    response_format: "b64_json",
    output_format: "png",
  });
  expect(await requests[1]!.clone().text()).toContain("sheet direction");
  expect(await requests[1]!.json()).toMatchObject({
    image: [`data:image/jpeg;base64,${photoPortrait.bytes.toString("base64")}`],
    input_fidelity: "high",
  });
  expect(await requests[2]!.clone().text()).toContain("photo direction");
  expect(await requests[2]!.json()).toMatchObject({
    size: "1024x1280",
    image: [
      `data:image/png;base64,${png.toString("base64")}`,
      `data:image/jpeg;base64,${photoPortrait.bytes.toString("base64")}`,
    ],
  });
});

test("configuration, missing credentials, prompt limits and budget rejection fail before image dispatch", async () => {
  const fetcher = vi.fn<typeof fetch>();
  expect(() => createProfileGenerator({ key: "", imageProvider: "typo" })).toThrow(
    "ADMIN_IMAGE_PROVIDER",
  );
  expect(() =>
    createProfileGenerator({
      key: "",
      imageProvider: "arena",
      imageModel: "gemini-3.1-flash-image",
    }),
  ).toThrow("canonical model");
  expect(() => createProfileGenerator({ key: "", imageModel: "gpt-image-2.5-sunburst" })).toThrow(
    "canonical model",
  );
  await expect(client(fetcher, " ").sheet(character, "photo")).rejects.toThrow(
    "ARENA_IMAGE_API_KEY",
  );
  await expect(
    createProfileGenerator({ key: "", imageProvider: "arena", fetcher }).sheet(character, "photo"),
  ).rejects.toThrow("ARENA_IMAGE_API_KEY");
  await expect(client(fetcher).sheet(character, "photo", "x".repeat(32001))).rejects.toThrow(
    "provider limit",
  );
  const reserve = vi
    .fn<(micros: number) => Promise<void>>()
    .mockRejectedValue(new Error("budget exhausted"));
  await expect(
    withSeedingBudget(reserve, () => client(fetcher).sheet(character, "photo")),
  ).rejects.toThrow("budget exhausted");
  expect(reserve).toHaveBeenCalledWith(0);
  expect(fetcher).not.toHaveBeenCalled();
});

test("invalid responses, missing images and oversized or corrupt encodings never become images", async () => {
  const responses = [
    new Response("not json"),
    Response.json({ data: [] }),
    Response.json({ data: [{ url: "https://untrusted.test/image.png" }] }),
    ...["", "%%%", `${png.toString("base64")} `, Buffer.alloc(20_000_001).toString("base64")].map(
      (b64_json) => Response.json({ data: [{ b64_json }] }),
    ),
  ];
  for (const response of responses)
    await expect(client(async () => response).sheet(character, "photo")).rejects.toThrow(
      /Invalid image response|Invalid portrait/,
    );
});

test.each([429, 502, 503, 504])(
  "Arena HTTP %i never automatically repeats an uncertain image request",
  async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          error: {
            message: "failure arena-secret",
            code: "upstream_error",
            type: "provider_error",
          },
        },
        { status },
      ),
    );
    const reserve = vi.fn<(micros: number) => Promise<void>>().mockResolvedValue(undefined);
    await expect(
      withSeedingBudget(reserve, () => client(fetcher).sheet(character, "anime")),
    ).rejects.toMatchObject({
      message: "failure <REDACTED>",
      fields: { status, code: "upstream_error", providerStatus: "provider_error" },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

test("non-JSON failures and transport errors retain safe diagnostics", async () => {
  for (const response of [
    new Response("secret proxy failure", { status: 502 }),
    Response.json({ error: { code: null } }, { status: 400 }),
  ])
    await expect(client(async () => response).sheet(character, "photo")).rejects.toMatchObject({
      message: "Image generation failed",
      fields: { code: "http_error" },
    });
  await expect(
    client(async () => {
      throw new Error("disconnected arena-secret");
    }).sheet(character, "photo"),
  ).rejects.toMatchObject({
    message: "disconnected <REDACTED>",
    fields: { code: "network_error" },
  });
});
