import { expect, test } from "vitest";
import { fixture, portraitImage, request } from "../test/fixtures.ts";
import { storedLayers } from "../test/artwork-layers.ts";
import { saveArtworkLayerLayout } from "./artwork-layer-layout.ts";

async function setup() {
  const f = await fixture();
  const source = {
    model: "fal:source",
    operationId: "art-source",
    imageUrl: await f.store.saveImage(portraitImage),
  };
  await f.store.saveRigArtwork("target", source);
  await f.store.saveRigArtworkLayers("target", storedLayers(source.imageUrl));
  const path = "/personas/target/artwork-layers/layout";
  const form = {
    source: "art-source",
    result: "layer-result",
    layer: "1",
    x: "0.25",
    y: "0.25",
    width: "0.5",
    height: "0.5",
  };
  return { ...f, source, path, form };
}

test("operator placement changes preserve original PNGs and the paid generation receipt, with CAS", async () => {
  const f = await setup();
  const response = await f.admin(request(f.path, f.form));
  expect(response.status).toBe(303);
  const image = (await f.store.rigArtwork("target"))!;
  expect(image.imageUrl).toBe(f.source.imageUrl);
  expect(image.layers!.generationOperationId).toBe("layer-result");
  expect(image.layers!.operationId).not.toBe("layer-result");
  expect(image.layers!.layers[1]!.bounds).toEqual([0.25, 0.25, 0.75, 0.75]);
  expect((await f.admin(request(f.path, f.form))).status).toBe(409);
  const second = await f.admin(request(f.path, { ...f.form, result: image.layers!.operationId }));
  expect(second.status).toBe(303);
  expect((await f.store.rigArtwork("target"))!.layers!.generationOperationId).toBe("layer-result");
});

test.each([
  { layer: "0" },
  { layer: "2" },
  { layer: "0.5" },
  { x: "-1" },
  { y: "-1" },
  { width: "0" },
  { height: "0" },
  { x: "1" },
  { y: "1" },
  { width: "NaN" },
  { height: "" },
])("invalid placement %j is rejected before any artifact change", async (patch) => {
  const f = await setup();
  expect((await f.admin(request(f.path, { ...f.form, ...patch }))).status).toBe(400);
  expect((await f.store.rigArtwork("target"))!.layers!.operationId).toBe("layer-result");
});

test("layout authentication, origin, source identity, locks and method constraints are enforced", async () => {
  const f = await setup();
  expect((await f.admin(new Request(`http://localhost:3729${f.path}`))).status).toBe(401);
  expect((await f.admin(request(f.path))).status).toBe(405);
  const cross = request(f.path, f.form);
  cross.headers.set("origin", "https://other.example");
  expect((await f.admin(cross)).status).toBe(400);
  expect((await f.admin(request(f.path, { ...f.form, source: "old" }))).status).toBe(409);
  expect((await f.admin(request("/personas/missing/artwork-layers/layout", f.form))).status).toBe(
    409,
  );
  await expect(
    saveArtworkLayerLayout(
      request(f.path, f.form),
      new URL(`http://localhost:3729${f.path}`),
      f.store,
      () => true,
    ),
  ).rejects.toThrow("이미지 작업");
  expect(
    (
      await saveArtworkLayerLayout(
        request("/other", f.form),
        new URL("http://localhost:3729/other"),
        f.store,
        () => false,
      )
    ).status,
  ).toBe(404);
});
