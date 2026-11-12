import { expect, test } from "vitest";
import { imageModelResponse } from "./image-model-response.ts";
import { png, photoPortrait, webp } from "../test/fixtures.ts";

test("provider MIME types remain correct for JPEG and WebP outputs", async () => {
  const jpeg = await imageModelResponse(
    Response.json({ data: [{ b64_json: photoPortrait.bytes.toString("base64") }] }),
    "openai",
    "jpeg",
  );
  expect(jpeg).toEqual(photoPortrait);
  const result = await imageModelResponse(
    Response.json({ data: [{ b64_json: webp.toString("base64"), media_type: "image/webp" }] }),
    "openrouter",
    "webp",
  );
  expect(result.mimeType).toBe("image/webp");
  expect(result.bytes).toEqual(webp);
});

test("thought images are ignored and more than one Google output is rejected", async () => {
  const inlineData = { data: png.toString("base64"), mimeType: "image/png" };
  const single = await imageModelResponse(
    Response.json({
      candidates: [{ content: { parts: [{ thought: true, inlineData }, { inlineData }] } }],
    }),
    "google",
    "png",
  );
  expect(single.bytes).toEqual(png);
  await expect(
    imageModelResponse(
      Response.json({ candidates: [{ content: { parts: [{ inlineData }, { inlineData }] } }] }),
      "google",
      "png",
    ),
  ).rejects.toThrow("exactly one");
});

test("unsupported, absent or mismatched output types never become stored portraits", async () => {
  await expect(
    imageModelResponse(
      Response.json({ data: [{ b64_json: png.toString("base64"), media_type: "image/svg+xml" }] }),
      "openrouter",
      "png",
    ),
  ).rejects.toThrow(/media_type/);
  await expect(
    imageModelResponse(
      Response.json({ data: [{ b64_json: png.toString("base64") }] }),
      "openrouter",
      "png",
    ),
  ).rejects.toThrow(/image/);
  await expect(
    imageModelResponse(
      Response.json({ data: [{ b64_json: photoPortrait.bytes.toString("base64") }] }),
      "openai",
      "png",
    ),
  ).rejects.toThrow("PNG");
});
