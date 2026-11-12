import { expect, test, vi } from "vitest";
import { fixture, portraitImage, request, png } from "../test/fixtures.ts";
import { storedLayers } from "../test/artwork-layers.ts";
import { saveRigFace } from "./rig-face-save.ts";

async function setup() {
  const f = await fixture();
  const imageUrl = await f.store.saveImage(portraitImage);
  await f.store.saveRigArtwork("target", {
    model: "test",
    operationId: "art-source",
    imageUrl,
    kind: "body",
  });
  await f.store.saveRigArtworkLayers("target", storedLayers(imageUrl));
  const path = "/personas/target/rig-face";
  const fields = {
    source: "art-source",
    result: "layer-result",
    action: "upload",
    role: "mouth",
    state: "neutral",
  };
  const upload = (patch: Record<string, string> = {}, bytes: Uint8Array = png) => {
    const form = new FormData();
    for (const [key, value] of Object.entries({ ...fields, ...patch })) form.set(key, value);
    form.set("image", new File([new Uint8Array(bytes)], "part.png", { type: "image/png" }));
    const headers = request(path, {}).headers;
    headers.delete("content-type");
    return new Request(`http://localhost:3729${path}`, {
      method: "POST",
      headers,
      body: form,
    });
  };
  return { ...f, path, fields, upload, read: () => f.store.rigArtwork("target") };
}

test("part imports persist privately, replace only the same role/state, and retain body and paid receipts across CAS edits", async () => {
  const f = await setup();
  expect((await f.admin(f.upload())).status).toBe(303);
  const first = (await f.read())!;
  expect(first.layers!.faceParts).toHaveLength(1);
  expect(first.layers!.generationOperationId).toBe("layer-result");
  expect(first.operationId).toBe("art-source");
  const oldUrl = first.layers!.faceParts![0]!.imageUrl;
  expect((await f.admin(f.upload())).status).toBe(409);
  expect((await f.admin(f.upload({ result: first.layers!.operationId }))).status).toBe(303);
  const second = (await f.read())!;
  expect(second.layers!.faceParts).toHaveLength(1);
  expect(second.layers!.faceParts![0]!.imageUrl).not.toBe(oldUrl);
  const deletion = request(f.path, {
    ...f.fields,
    action: "delete",
    result: second.layers!.operationId,
  });
  expect((await f.admin(deletion)).status).toBe(303);
  expect((await f.read())!.layers!.faceParts).toEqual([]);
  expect((await f.read())!.layers!.layers).toEqual(first.layers!.layers);
  const empty = (await f.read())!.layers!;
  expect(
    (
      await f.admin(
        f.upload({ result: empty.operationId, role: "eye-left", state: "happy", eyeClosed: "on" }),
      )
    ).status,
  ).toBe(303);
  const closed = (await f.read())!.layers!;
  expect(closed.faceParts![0]).toMatchObject({ role: "eye-left", state: "happy", closed: true });
  expect((await f.admin(f.upload({ result: closed.operationId, eyeClosed: "on" }))).status).toBe(
    400,
  );
});

test("body-relative hair planes persist with no change to the original images", async () => {
  const f = await setup();
  expect(
    (
      await f.admin(
        request(f.path, {
          ...f.fields,
          action: "planes",
          "plane-0": "body",
          "plane-1": "front-body",
        }),
      )
    ).status,
  ).toBe(303);
  expect((await f.read())!.layers!.layers[1]!.plane).toBe("front-body");
});

test("a full face pack refuses additions before saving images", async () => {
  const f = await setup();
  const current = (await f.read())!.layers!;
  await f.store.saveRigArtworkLayers(
    "target",
    {
      ...current,
      operationId: "full",
      faceParts: Array.from({ length: 40 }, () => ({
        role: "base" as const,
        state: "neutral" as const,
        imageUrl: current.layers[0]!.imageUrl,
      })),
    },
    current.operationId,
  );
  expect((await f.admin(f.upload({ result: "full" }))).status).toBe(400);
  expect((await f.read())!.layers!.faceParts).toHaveLength(40);
});

test.each([
  { action: "planes" },
  { role: "nope" },
  { state: "nope" },
  { role: "base", state: "happy" },
  { action: "wrong" },
])("invalid face edits %j preserve the previous result", async (patch) => {
  const f = await setup();
  expect((await f.admin(f.upload(patch))).status).toBe(400);
  expect((await f.read())!.layers!.operationId).toBe("layer-result");
});

test("uploads reject missing, oversized, corrupt, wrong-format and wrong-sized files before publishing", async () => {
  const f = await setup();
  expect((await f.admin(request(f.path, f.fields))).status).toBe(400);
  for (const bytes of [
    new Uint8Array(),
    new Uint8Array(10 * 1024 * 1024 + 1),
    new Uint8Array([1, 2, 3]),
    png.subarray(0, 12),
  ])
    expect((await f.admin(f.upload({}, bytes))).status).toBe(400);
  const current = (await f.read())!.layers!;
  await f.store.saveRigArtworkLayers(
    "target",
    { ...current, width: 2, operationId: "new-size" },
    current.operationId,
  );
  expect((await f.admin(f.upload({ result: "new-size" }))).status).toBe(400);
  expect((await f.read())!.layers!.faceParts).toBeUndefined();
});

test("authentication, origin, method, stale bodies and queue locks guard face edits", async () => {
  const f = await setup();
  expect((await f.admin(new Request(`http://localhost${f.path}`))).status).toBe(401);
  expect((await f.admin(request(f.path))).status).toBe(405);
  const cross = f.upload();
  cross.headers.set("origin", "https://other.example");
  expect((await f.admin(cross)).status).toBe(400);
  expect((await f.admin(f.upload({ source: "old" }))).status).toBe(409);
  expect((await f.admin(request("/personas/missing/rig-face", f.fields))).status).toBe(409);
  await expect(
    saveRigFace(f.upload(), new URL(`http://localhost:3729${f.path}`), f.store, () => true),
  ).rejects.toThrow("이미지 작업");
  const lock = vi.fn<() => boolean>().mockReturnValueOnce(false).mockReturnValue(true);
  await expect(
    saveRigFace(f.upload(), new URL(`http://localhost:3729${f.path}`), f.store, lock),
  ).rejects.toThrow("시작");
  expect((await f.read())!.layers!.operationId).toBe("layer-result");
  expect(
    (
      await saveRigFace(
        request("/other", {}),
        new URL("http://localhost:3729/other"),
        f.store,
        () => false,
      )
    ).status,
  ).toBe(404);
});
