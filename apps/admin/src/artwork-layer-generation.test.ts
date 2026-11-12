import { expect, test, vi } from "vitest";
import { Schema } from "effect";
import { layerService, layerFetch, layerResponse } from "../test/artwork-layers.ts";
import { portraitImage } from "../test/fixtures.ts";
import { createArtworkLayerizer } from "./artwork-layer-generation.ts";
import { ArtworkLayerOptions, artworkLayerModel } from "./artwork-layer-model.ts";
import { PersonaError } from "@ren-ai/personas";
import { fetchUrl } from "../test/fetch-url.ts";
import { imageSize } from "image-size";

test("outfit decomposition requests no body pixels and keeps joint-specific rounded clothing overlaps", async () => {
  const { service, fetcher } = layerService();
  const { selection } = await service.options("outfit-source");
  await service.generate(selection, "ribbons", portraitImage, undefined, "outfit");
  const paid = fetcher.mock.calls.find(
    ([input, init]) =>
      fetchUrl(input).startsWith("https://queue.fal.run/") && init?.method === "POST",
  )!;
  const body = Schema.decodeUnknownSync(Schema.Struct({ prompt: Schema.String }))(
    await new Request(...paid).json(),
  );
  expect(body.prompt).toContain("clothing-only overlay");
  expect(body.prompt).toContain("no skin, body, face, hair, underwear or ghost silhouettes");
  expect(body.prompt).toContain("rounded overlapping extensions");
});

test("price confirmation is signed for one source and layerize sends one private original without a fallback", async () => {
  const { service, fetcher } = layerService();
  const options = Schema.decodeUnknownSync(ArtworkLayerOptions)(
    await service.options("art-source"),
  );
  const selection = service.selected(options.quote, "art-source");
  expect(selection.price).toContain("0.03375 / 레이어");
  expect(() => service.selected(options.quote, "other-source")).toThrow("원화가 변경");
  expect(() => service.selected(options.quote + "bad", "art-source")).toThrow(PersonaError);
  expect(await service.generate(selection, "private direction", portraitImage)).toEqual(
    layerResponse,
  );
  expect(fetcher).toHaveBeenCalledTimes(6);
  const paid = fetcher.mock.calls.find(
    ([input, init]) =>
      fetchUrl(input).startsWith("https://queue.fal.run/") && init?.method === "POST",
  )!;
  const init = paid[1]!;
  expect(paid[0]).toBe(`https://queue.fal.run/${artworkLayerModel}`);
  expect(
    fetcher.mock.calls.some(
      ([input]) =>
        fetchUrl(input) ===
        "https://queue.fal.run/bytedance/seedream/requests/test-layer-request/status",
    ),
  ).toBe(true);
  expect(init.redirect).toBe("manual");
  const body = Schema.decodeUnknownSync(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Boolean])),
  )(await new Request(paid[0], init).json());
  expect(body["image_url"]).toBe("https://v3b.fal.media/source.png");
  const upload = fetcher.mock.calls.find(
    ([, requestOptions]) => requestOptions?.method === "PUT",
  )![1]!.body;
  if (!(upload instanceof Blob)) throw new Error("Expected source upload blob");
  expect(upload.type).toBe("image/jpeg");
  expect(imageSize(new Uint8Array(await upload.arrayBuffer()))).toMatchObject({
    width: 1,
    height: 1,
  });
  expect(body["sync_mode"]).toBe(false);
  expect(body["image_size"]).toBe("auto_1.5K");
  expect(body["prompt"]).toContain("private direction");
  expect(body["prompt"]).toContain("UPPER ARM: shoulder-to-ELBOW");
  expect(body["prompt"]).toContain("FOREARM: ELBOW-to-WRIST");
  expect(body["prompt"]).toContain("rounded capsule-like end");
  expect(body["prompt"]).toContain("no dark cut-outline");
  expect(body["prompt"]).toContain("background must be empty of character pixels");
  expect(body["prompt"]).toContain("complete neck");
  expect(body["prompt"]).toContain("Recombining all layers must reconstruct the complete original");
  expect(await service.download(layerResponse.layers[0]!.image.url)).toEqual({
    ...portraitImage,
    bytes: new Uint8Array(portraitImage.bytes),
  });
});

test.each(
  [
    [],
    [{ endpoint_id: artworkLayerModel, unit_price: 0, currency: "USD" }],
    [{ endpoint_id: artworkLayerModel, unit_price: -1, currency: "USD" }],
  ].map((prices) => ({ prices })),
)("missing or invalid account prices cannot enable confirmation", async ({ prices }) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ prices }));
  await expect(
    createArtworkLayerizer("key", "password", fetcher).options("source"),
  ).rejects.toThrow("단가");
  expect(fetcher).toHaveBeenCalledOnce();
});

test("missing credentials stop before requests", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const service = createArtworkLayerizer(" ", "password", fetcher);
  await expect(service.options("source")).rejects.toThrow("FAL_KEY");
  const { service: configured } = layerService();
  const { selection } = await configured.options("source");
  await expect(service.generate(selection, "", portraitImage)).rejects.toThrow("FAL_KEY");
  expect(fetcher).not.toHaveBeenCalled();
});

test("queue recovery only reads the known request, with no image upload or paid submission", async () => {
  const { service, fetcher } = layerService();
  expect(await service.resume("saved-request")).toEqual(layerResponse);
  expect(fetcher.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

test("queue polling waits for completion and bounded pending work remains resumable", async () => {
  vi.useFakeTimers();
  try {
    const { service, fetcher } = layerService();
    fetcher.mockResolvedValueOnce(Response.json({ status: "IN_QUEUE" }));
    const completed = service.resume("queued-request");
    await vi.advanceTimersByTimeAsync(5000);
    expect(await completed).toEqual(layerResponse);
    fetcher.mockImplementation(async () => Response.json({ status: "IN_PROGRESS" }));
    const pending = service.resume("still-pending");
    await Promise.all([
      expect(pending).rejects.toMatchObject({ fields: { code: "layer_result_pending" } }),
      vi.runAllTimersAsync(),
    ]);
  } finally {
    vi.useRealTimers();
  }
});

test.each(["http", "json"])(
  "recovery %s failures retain safe provider diagnostics",
  async (failure) => {
    const { service, fetcher } = layerService();
    fetcher.mockResolvedValueOnce(
      failure === "http" ? new Response(null, { status: 422 }) : new Response("bad json"),
    );
    await expect(service.resume("saved-request")).rejects.toMatchObject({
      fields: { code: failure === "http" ? "http_error" : "invalid_response" },
    });
  },
);

test.each(["http", "network", "json", "order", "duplicate"])(
  "provider %s failures are observed without automatic paid retry",
  async (failure) => {
    const { service, fetcher } = layerService();
    const { selection } = await service.options("source");
    fetcher.mockImplementation(async (input, init) => {
      const url = fetchUrl(input);
      if (url.startsWith("https://queue.fal.run/") && init?.method === "POST") {
        if (failure === "network") throw new Error("private direction layer-key");
        if (failure === "http") return new Response("private direction", { status: 429 });
        if (failure === "json") return new Response("not JSON");
      }
      if (
        url.includes("/requests/") &&
        !url.endsWith("/status") &&
        ["order", "duplicate"].includes(failure)
      )
        return Response.json({
          layers: layerResponse.layers.map((layer) => ({
            ...layer,
            z_index: failure === "order" ? layer.z_index + 1 : 0,
          })),
        });
      return layerFetch(input, init);
    });
    await expect(
      service.generate(selection, "private direction", portraitImage),
    ).rejects.toMatchObject({
      fields: {
        code:
          failure === "network"
            ? "network_error"
            : failure === "http"
              ? "http_error"
              : "invalid_response",
      },
    });
    expect(
      fetcher.mock.calls.filter(
        ([input, init]) =>
          fetchUrl(input).startsWith("https://queue.fal.run/") && init?.method === "POST",
      ),
    ).toHaveLength(1);
  },
);

test.each([
  "http://v3b.fal.media/a.png",
  "https://evil.example/a.png",
  "https://user:pass@v3b.fal.media/a.png",
  "not-a-url",
])("layer download refuses untrusted URL %s", async (url) => {
  const { service, fetcher } = layerService();
  await expect(service.download(url)).rejects.toThrow(/Invalid (layer image host|URL)/);
  expect(fetcher).not.toHaveBeenCalled();
});

test.each(["http", "network", "invalid-png"])(
  "download %s failure never sends a generation request",
  async (failure) => {
    const { service, fetcher } = layerService();
    if (failure === "network") fetcher.mockRejectedValueOnce(new Error("offline"));
    else
      fetcher.mockResolvedValueOnce(
        new Response("bad", { status: failure === "http" ? 503 : 200 }),
      );
    await expect(service.download(layerResponse.layers[0]!.image.url)).rejects.toMatchObject({
      fields: {
        code:
          failure === "http"
            ? "image_http_error"
            : failure === "network"
              ? "network_error"
              : "invalid_layer_image",
      },
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]![1]?.method).not.toBe("POST");
    expect(await layerFetch(layerResponse.layers[0]!.image.url)).toBeInstanceOf(Response);
  },
);
