import { expect, test, vi } from "vitest";
import { createRigArtworkGenerator } from "./rig-artwork-generation.ts";
import { png, portraitImage } from "../test/fixtures.ts";
import {
  fluxModel,
  seedreamModel,
  testImageConnections,
  testModels,
  openaiModel,
  googleModel,
  routerModel,
} from "../test/image-models.ts";
import type { ImageModelSelection } from "./image-model.ts";

const data = png.toString("base64");
const falReply = () => Response.json({ images: [{ url: `data:image/png;base64,${data}` }] });

async function generatedRequest(
  selection: ImageModelSelection,
  target?: "body" | "outfit" | "face",
) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
    if (selection.provider === "fal") return falReply();
    if (selection.provider === "google")
      return Response.json({
        candidates: [
          {
            content: {
              parts: [{ text: "generated" }, { inlineData: { data, mimeType: "image/png" } }],
            },
          },
        ],
      });
    return Response.json({ data: [{ b64_json: data, media_type: "image/png" }] });
  });
  const result = await createRigArtworkGenerator(testImageConnections, fetcher)(
    selection,
    "adult witch",
    "gentle smile",
    portraitImage,
    target,
  );
  return { fetcher, result, request: new Request(...fetcher.mock.calls[0]!) };
}

test("outfit edits keep the body reference and request only aligned garments and ornaments", async () => {
  const { request } = await generatedRequest(openaiModel, "outfit");
  const form = await request.formData();
  expect(form.get("prompt")).toContain("CLOTHING-ONLY overlay");
  expect(form.get("prompt")).toContain("Omit ALL skin, face, hair, body and underwear pixels");
  expect(form.get("prompt")).toContain("Do not move, resize, crop or redraw");
  expect(form.get("image[]")).toBeInstanceOf(File);
  expect(form.get("n")).toBe("1");
});

test("facial edits preserve the supplied face framing without issuing body or clothing instructions", async () => {
  const { request } = await generatedRequest(openaiModel, "face");
  const form = await request.formData();
  expect(form.get("prompt")).toContain("aligned facial animation asset");
  expect(form.get("prompt")).not.toContain("Relaxed A-pose");
  expect(form.get("n")).toBe("1");
});

test.each(testModels)(
  "$id generates one validated image without redirects or repeat calls",
  async (selection) => {
    const { fetcher, result, request } = await generatedRequest(selection);
    expect(result).toEqual(portraitImage);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(request.redirect).toBe("manual");
  },
);

test("OpenAI receives a multipart edit with the sheet original and one-image limit", async () => {
  const { request } = await generatedRequest(openaiModel);
  expect(request.url).toBe("https://api.openai.com/v1/images/edits");
  const form = await request.formData();
  expect(form.get("model")).toBe(openaiModel.model);
  expect(form.get("n")).toBe("1");
  expect(form.get("prompt")).toContain("gentle smile");
  expect(form.get("prompt")).toContain("continuous skin and soft tissue");
  expect(form.get("prompt")).toContain("white background is visible BETWEEN the two legs");
  expect(form.get("prompt")).toContain("one continuous intact limb");
  expect(form.get("prompt")).toContain("No ball-jointed doll");
  expect(form.get("prompt")).toContain("plain opaque undecorated underwear");
  expect(form.get("prompt")).toContain("No outer clothing, shoes, stockings");
  expect(form.get("prompt")).not.toMatch(
    /skeletal rig|compatible with rigging|joints unobstructed/,
  );
  const file = form.get("image[]");
  if (!file || typeof file === "string") throw new Error("Expected image reference file");
  expect(Buffer.from(await file.arrayBuffer())).toEqual(png);
});

test.each([seedreamModel, fluxModel])(
  "$id receives an inline original and schema-verified single-image options",
  async (selection) => {
    const { request } = await generatedRequest(selection);
    expect(request.url).toBe(`https://fal.run/${selection.model}`);
    expect(request.headers.get("authorization")).toBe("Key private-key");
    expect(await request.json()).toMatchObject({
      image_urls: [`data:image/png;base64,${data}`],
      num_images: 1,
      sync_mode: true,
    });
  },
);

test("Google uses native inlineData rather than a public or localhost reference URL", async () => {
  const { request } = await generatedRequest(googleModel);
  expect(request.headers.get("x-goog-api-key")).toBe("google-key");
  expect(request.url).toContain(encodeURIComponent(googleModel.model));
  expect(await request.clone().text()).toContain(data);
  expect(await request.text()).toContain("gentle smile");
});

test("OpenRouter uses its dedicated image API with fallback routing disabled", async () => {
  const { request } = await generatedRequest(routerModel);
  expect(request.url).toBe("https://openrouter.ai/api/v1/images");
  expect(await request.json()).toMatchObject({
    model: routerModel.model,
    n: 1,
    input_references: [{ type: "image_url", image_url: { url: `data:image/png;base64,${data}` } }],
    provider: { allow_fallbacks: false },
  });
});

test("missing credentials, HTTP and network failures never resubmit or switch a paid model", async () => {
  const fetcher = vi.fn<typeof fetch>();
  await expect(
    createRigArtworkGenerator({ ...testImageConnections, fal: " " }, fetcher)(
      seedreamModel,
      "witch",
      "",
      portraitImage,
    ),
  ).rejects.toMatchObject({ fields: { code: "missing_key" } });
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockResolvedValue(new Response("private-key private-input", { status: 429 }));
  await expect(
    createRigArtworkGenerator(testImageConnections, fetcher)(
      seedreamModel,
      "private-input",
      "",
      portraitImage,
    ),
  ).rejects.toMatchObject({
    message: "Artwork provider request failed",
    fields: { status: 429, code: "http_error" },
  });
  fetcher.mockRejectedValue(new Error(`private-key private-input data:image/png;base64,${data}`));
  await expect(
    createRigArtworkGenerator(testImageConnections, fetcher)(
      seedreamModel,
      "private-input",
      "",
      portraitImage,
    ),
  ).rejects.toThrow("<REDACTED> <REDACTED> <REDACTED>");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test.each([
  "not-json",
  JSON.stringify({ images: [] }),
  JSON.stringify({ images: [{ url: "http://127.0.0.1/private" }] }),
  JSON.stringify({ images: [{ url: "data:image/png;base64,???" }] }),
  JSON.stringify({ images: [{ url: "data:image/png;base64,YWJj" }] }),
])("invalid image output is rejected without fetching arbitrary URLs", async (body) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
  await expect(
    createRigArtworkGenerator(testImageConnections, fetcher)(fluxModel, "witch", "", portraitImage),
  ).rejects.toMatchObject({
    message: "Invalid artwork provider response",
    fields: { code: "invalid_response" },
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
