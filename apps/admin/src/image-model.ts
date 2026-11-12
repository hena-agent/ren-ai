import { Schema } from "effect";

export const ImageProvider = Schema.Literals(["openai", "google", "openrouter", "fal"]);
export type ImageProvider = typeof ImageProvider.Type;
export const ImageModelSelection = Schema.Struct({
  id: Schema.String,
  provider: ImageProvider,
  model: Schema.String,
  name: Schema.String,
  providerName: Schema.String,
  price: Schema.String,
  observedAt: Schema.Number,
  outputFormat: Schema.Literals(["png", "jpeg", "webp"]),
  referenceField: Schema.Literals(["image_urls", "image_url"]),
  size: Schema.Literals(["pixels", "ratio", "default"]),
  fields: Schema.Array(Schema.String),
});
export type ImageModelSelection = typeof ImageModelSelection.Type;
export const ImageModelEntry = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  name: Schema.String,
  providerName: Schema.String,
  releaseDate: Schema.String,
  price: Schema.String,
  outputFormat: Schema.Literals(["png", "jpeg", "webp"]),
  connected: Schema.Boolean,
  reason: Schema.String,
});
export type ImageModelEntry = typeof ImageModelEntry.Type;
export const ImageModelPage = Schema.Struct({
  models: Schema.Array(ImageModelEntry),
  errors: Schema.Array(Schema.String),
  nextCursor: Schema.NullOr(Schema.String),
});
export type ImageModelPage = typeof ImageModelPage.Type;
export type ImageConnections = Readonly<Record<ImageProvider, string>>;
export interface ImageModels {
  list: (query: string, cursor: string | null, refresh: boolean) => Promise<ImageModelPage>;
  resolve: (id: string) => Promise<ImageModelSelection>;
  quote: (selection: ImageModelSelection) => string;
  selected: (
    quote: FormDataEntryValue | null,
    id: FormDataEntryValue | null,
  ) => ImageModelSelection;
}

export const imageProviders = {
  openai: { name: "OpenAI", key: "OPENAI_API_KEY", base: "https://api.openai.com/v1" },
  google: {
    name: "Google",
    key: "GEMINI_API_KEY",
    base: "https://generativelanguage.googleapis.com/v1beta",
  },
  openrouter: {
    name: "OpenRouter",
    key: "OPENROUTER_API_KEY",
    base: "https://openrouter.ai/api/v1",
  },
  fal: { name: "fal", key: "FAL_KEY", base: "https://fal.run" },
} as const;

export function imageModelId(provider: string, model: string) {
  if (
    !/^[a-z0-9-]+$/.test(provider) ||
    !/^[a-zA-Z0-9@][a-zA-Z0-9@._:/-]{0,239}$/.test(model) ||
    model.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error("Invalid image model identifier");
  return `${provider}:${model}`;
}
