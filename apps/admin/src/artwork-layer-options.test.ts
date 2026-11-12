import { expect, test, vi } from "vitest";
import { Schema } from "effect";
import { fixture, generator, portraitImage, request } from "../test/fixtures.ts";
import { layerService } from "../test/artwork-layers.ts";
import { captureArtworkLayers } from "./artwork-layer-options.ts";

const Failure = Schema.Struct({ error: Schema.String, requestId: Schema.String });

test("options errors are authenticated JSON with safe request correlation and never paid calls", async () => {
  const { service, fetcher } = layerService();
  const { admin, store, logs } = await fixture({ ...generator, layerize: service });
  const path = "/artwork-layer-options";
  expect((await admin(new Request(`http://localhost:3729${path}`))).status).toBe(401);
  expect((await admin(request(path, { intent: "rig-layers" }))).status).toBe(405);
  for (const query of ["", "?persona=../bad", "?persona=missing&source=source"]) {
    const response = await admin(request(path + query));
    const body = Schema.decodeUnknownSync(Failure)(await response.json());
    expect(response.status).toBe(query.includes("missing") ? 409 : 400);
    expect(body.requestId).toBe(response.headers.get("X-Request-ID"));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
  await store.saveRigArtwork("target", {
    model: "fal:source",
    imageUrl: await store.saveImage(portraitImage),
    operationId: "source",
  });
  expect((await admin(request(`${path}?persona=target&source=old`))).status).toBe(409);
  vi.spyOn(service, "options").mockRejectedValueOnce(new Error("account pricing offline"));
  const failed = await admin(request(`${path}?persona=target&source=source`));
  expect(failed.status).toBe(503);
  expect(Schema.decodeUnknownSync(Failure)(await failed.json()).error).toBe(
    "레이어 분리 정보를 읽지 못했습니다.",
  );
  expect(
    logs.find((entry) => entry.stage === "rig.layers.options" && entry.level === "error"),
  ).toBeDefined();
  expect(fetcher).not.toHaveBeenCalled();
  const { admin: unconfigured } = await fixture();
  const missing = await unconfigured(request(path));
  expect(missing.status).toBe(400);
  expect(Schema.decodeUnknownSync(Failure)(await missing.json()).error).toContain("FAL_KEY");
});

test("a paid layer input requires both an original artwork and configured service", () => {
  const draft = { id: "target", base: "", preview: "" };
  const { service } = layerService();
  expect(() => captureArtworkLayers(draft, new FormData(), "rig-layers", service)).toThrow(
    "현재 원화",
  );
  expect(() =>
    captureArtworkLayers(
      {
        ...draft,
        rigArtwork: {
          model: "fal:source",
          image: { model: "fal:source", imageUrl: "/images/source.png", operationId: "source" },
        },
      },
      new FormData(),
      "rig-layers",
      undefined,
    ),
  ).toThrow("FAL_KEY");
});
