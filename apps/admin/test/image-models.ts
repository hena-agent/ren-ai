import type { ImageConnections, ImageModelSelection, ImageProvider } from "../src/image-model.ts";
import { createImageModelCatalog } from "../src/image-model-catalog.ts";
import { fetchUrl } from "./fetch-url.ts";

export const testImageConnections: ImageConnections = {
  fal: "private-key",
  google: "google-key",
  openai: "openai-key",
  openrouter: "router-key",
};
function testSelection(provider: ImageProvider, model: string): ImageModelSelection {
  return {
    id: `${provider}:${model}`,
    provider,
    model,
    name: model,
    providerName: provider,
    price: "USD 0.035 / image",
    outputFormat: "png",
    observedAt: 1_793_879_000_000,
    referenceField: "image_urls",
    size: provider === "fal" ? "pixels" : "default",
    fields:
      provider === "fal"
        ? [
            "prompt",
            "image_urls",
            "image_size",
            "num_images",
            "max_images",
            "sequential_image_generation",
            "output_format",
            "sync_mode",
          ]
        : [],
  };
}
export const seedreamModel = testSelection("fal", "fal-ai/bytedance/seedream/v5/lite/edit");
export const fluxModel = testSelection("fal", "fal-ai/flux-2/klein/9b/edit");
export const openaiModel = testSelection("openai", "gpt-image-new");
export const googleModel = testSelection("google", "gemini-new-image");
export const routerModel = testSelection("openrouter", "vendor/new-image");
export const testModels = [seedreamModel, fluxModel, openaiModel, googleModel, routerModel];

export function falSchema(model: string) {
  return {
    components: {
      schemas: {
        Input: {
          required: ["prompt", "image_urls"],
          properties: {
            prompt: { type: "string" },
            image_urls: { type: "array", minItems: 1 },
            image_size: { anyOf: [{ $ref: "#/components/schemas/Size" }] },
            num_images: { type: "integer" },
            max_images: { type: "integer" },
            sequential_image_generation: { type: "string" },
            output_format: { enum: ["png", "jpeg"] },
            sync_mode: { type: "boolean" },
          },
        },
        Output: { properties: { images: { type: "array" } } },
        Size: { properties: { width: { type: "integer" }, height: { type: "integer" } } },
      },
    },
    paths: {
      [`/${model}`]: {
        post: {
          requestBody: {
            content: { "application/json": { schema: { $ref: "#/components/schemas/Input" } } },
          },
        },
      },
      [`/${model}/requests/{request_id}`]: {
        get: {
          responses: {
            "200": {
              content: { "application/json": { schema: { $ref: "#/components/schemas/Output" } } },
            },
          },
        },
      },
    },
  };
}

export function modelsDevFixture() {
  const providers = {
    openai: { name: "OpenAI", base: "https://api.openai.com/v1", selection: openaiModel },
    google: {
      name: "Google",
      base: "https://generativelanguage.googleapis.com/v1beta",
      selection: googleModel,
    },
    openrouter: {
      name: "OpenRouter",
      base: "https://openrouter.ai/api/v1",
      selection: routerModel,
    },
  };
  return Object.fromEntries(
    Object.entries(providers).map(([id, provider]) => [
      id,
      {
        name: provider.name,
        models: {
          [provider.selection.model]: {
            id: provider.selection.model,
            name: provider.selection.name,
            release_date: "2026-11-01",
            modalities: { input: ["text", "image/png", "image/jpeg"], output: ["image/png"] },
            api: { images: { base_url: provider.base } },
            cost: { image: { output: { price: 0.04, unit: "image" } } },
          },
        },
      },
    ]),
  );
}

export const modelCatalogFetch: typeof fetch = async (input) => {
  const url = new URL(fetchUrl(input));
  if (url.hostname === "models.dev") return Response.json(modelsDevFixture());
  const model = url.searchParams.get("endpoint_id");
  if (url.pathname.endsWith("openapi.json")) return Response.json(falSchema(model!));
  if (url.pathname.endsWith("pricing"))
    return Response.json({
      prices: [{ endpoint_id: model, unit_price: 0.035, unit: "image", currency: "USD" }],
    });
  const selected = model
    ? testModels.filter((entry) => entry.provider === "fal" && entry.model === model)
    : testModels.filter((entry) => entry.provider === "fal");
  return Response.json({
    models: selected.map((entry) => ({
      endpoint_id: entry.model,
      metadata: {
        display_name: entry.name,
        category: "image-to-image",
        status: "active",
        date: "2026-11-01",
      },
    })),
    next_cursor: null,
  });
};

export const testImageModels = createImageModelCatalog(
  testImageConnections,
  "test-password",
  modelCatalogFetch,
);
