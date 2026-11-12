import { expect, test, vi } from "vitest";
import { fixture, generator, legacy, request, portraitImage } from "../test/fixtures.ts";
import { seedreamModel } from "../test/image-models.ts";
import { storedLayers } from "../test/artwork-layers.ts";

test("the authenticated test page uses the persona's current artwork and never submits generation", async () => {
  const paid = vi.fn<NonNullable<typeof generator.rigArtwork>>();
  const { admin, store } = await fixture({ ...generator, rigArtwork: paid });
  await store.create(legacy);
  const path = `/personas/${legacy.id}/rig-test`;
  expect((await admin(new Request(`http://localhost${path}`))).status).toBe(401);
  expect((await admin(request(path))).status).toBe(404);
  const imageUrl = await store.saveImage(portraitImage);
  await store.saveRigArtwork(legacy.id, {
    model: seedreamModel.id,
    imageUrl,
    operationId: "test-operation",
  });
  expect((await admin(request(path))).status).toBe(404);
  const jointPositions = [{ name: "forearm_l", x: 0.364, y: 0.356 }];
  await store.saveRigArtworkLayers(legacy.id, {
    ...storedLayers(imageUrl, "test-operation"),
    jointPositions,
  });
  const manifest = await admin(request(`/personas/${legacy.id}/artwork-layers?download=1`));
  expect(await manifest.json()).toMatchObject({ jointPositions });
  const response = await admin(request(path));
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const page = await response.text();
  expect(page).toContain("/assets/rig-test.js");
  expect(page).not.toContain("/assets/admin-test.js");
  expect(page).toContain(imageUrl);
  expect(page).toContain("분리된 2개 PNG");
  expect(page).toContain("data-request-id=");
  const editor = await (await admin(request(`/personas/${legacy.id}`))).text();
  expect(editor).toContain(`href="${path}"`);
  expect(paid).not.toHaveBeenCalled();
  expect((await admin(request(path, { intent: "save" }))).status).toBe(405);
  expect((await admin(request("/not-a-persona/rig-test"))).status).toBe(404);
});
