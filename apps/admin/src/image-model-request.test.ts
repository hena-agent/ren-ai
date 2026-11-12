import { expect, test } from "vitest";
import { imageModelRequest } from "./image-model-request.ts";
import { seedreamModel, openaiModel } from "../test/image-models.ts";
import { photoPortrait } from "../test/fixtures.ts";

test("schema-discovered singular references and ratio/default sizes lower without unsupported fields", async () => {
  const ratio = imageModelRequest(
    {
      ...seedreamModel,
      referenceField: "image_url",
      size: "ratio",
      fields: ["prompt", "image_url", "num_images", "sync_mode"],
    },
    "key",
    "direction",
    photoPortrait,
  );
  const ratioRequest = new Request(ratio.url, {
    method: "POST",
    body: ratio.body,
    headers: ratio.headers,
  });
  expect(await ratioRequest.clone().json()).toMatchObject({
    aspect_ratio: "2:3",
    image_url: `data:image/jpeg;base64,${photoPortrait.bytes.toString("base64")}`,
  });
  expect(await ratioRequest.text()).not.toContain("max_images");
  const native = imageModelRequest(
    { ...seedreamModel, size: "default", fields: ["prompt", "image_urls", "sync_mode"] },
    "key",
    "direction",
    photoPortrait,
  );
  const nativeText = await new Request(native.url, {
    method: "POST",
    body: native.body,
    headers: native.headers,
  }).text();
  expect(nativeText).not.toContain("aspect_ratio");
  expect(nativeText).not.toContain("image_size");
  const openai = imageModelRequest(openaiModel, "key", "direction", photoPortrait);
  const request = new Request(openai.url, {
    method: "POST",
    body: openai.body,
    headers: openai.headers,
  });
  const file = (await request.formData()).get("image[]");
  if (!file || typeof file === "string") throw new Error("Expected image file");
  expect(file.name).toBe("identity-sheet.jpg");
});
