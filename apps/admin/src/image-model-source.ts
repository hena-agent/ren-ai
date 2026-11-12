import { Schema } from "effect";
import { PersonaError } from "@ren-ai/personas";
import {
  ImageProvider,
  imageModelId,
  imageProviders,
  type ImageConnections,
  type ImageModelEntry,
  type ImageModelSelection,
} from "./image-model.ts";
import { ModelCost, modelPrice } from "./image-model-pricing.ts";
import { GenerationError, operation, protect, validationFailure } from "./logging.ts";

const Model = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  release_date: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  modalities: Schema.Struct({
    input: Schema.Array(Schema.String),
    output: Schema.Array(Schema.String),
  }),
  api: Schema.Record(Schema.String, Schema.Struct({ base_url: Schema.String })),
  cost: Schema.optionalKey(ModelCost),
});
const Providers = Schema.Record(
  Schema.String,
  Schema.Struct({ name: Schema.String, models: Schema.Record(Schema.String, Model) }),
);
const image = (modality: string) =>
  modality === "image" || ["image/png", "image/jpeg", "image/webp"].includes(modality);

export async function catalogJson<T>(
  url: string,
  codec: Schema.Codec<T>,
  fetcher: typeof fetch,
  key = "",
): Promise<T> {
  protect(key);
  return operation("image.models.fetch", {}, async () => {
    const response = await fetcher(url, {
      headers: key ? { Authorization: `Key ${key}` } : {},
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new GenerationError("Image catalog request failed", {
        code: "catalog_http_error",
        status: response.status,
      });
    try {
      return Schema.decodeUnknownSync(codec)(await response.json());
    } catch (cause) {
      throw validationFailure("Invalid image catalog response", { code: "invalid_catalog" }, cause);
    }
  });
}

function protocolReason(provider: string, model: typeof Model.Type) {
  if (!Schema.is(ImageProvider)(provider) || provider === "fal")
    return "이 공급자의 이미지 호출 방식은 아직 연결되지 않았습니다";
  const api = model.api["images"] ?? model.api["generate-content"];
  if (api?.base_url.replace(/\/$/, "") !== imageProviders[provider].base)
    return "지원하는 이미지 API 주소와 일치하지 않습니다";
  return "";
}

function nativeReason(provider: string, model: typeof Model.Type, connected: boolean) {
  if (model.status === "deprecated") return "지원 종료 모델";
  if (!model.modalities.input.some(image)) return "참조 이미지 입력 미지원";
  return protocolReason(provider, model) || (connected ? "" : "공급자 API 키 미연결");
}

function outputFormat(model: typeof Model.Type): ImageModelEntry["outputFormat"] {
  if (model.modalities.output.includes("image/png") || model.modalities.output.includes("image"))
    return "png";
  return model.modalities.output.includes("image/jpeg") ? "jpeg" : "webp";
}

export async function modelsDevEntries(connections: ImageConnections, fetcher: typeof fetch) {
  return operation("image.models.catalog", {}, async () => {
    const providers = await catalogJson(
      "https://models.dev/experimental/v2.0/api.json?type=image",
      Providers,
      fetcher,
    );
    const entries: ImageModelEntry[] = [];
    for (const [provider, value] of Object.entries(providers)) {
      for (const model of Object.values(value.models)) {
        if (!model.modalities.output.some(image)) continue;
        const connected =
          Schema.is(ImageProvider)(provider) && Boolean(connections[provider].trim());
        const reason = nativeReason(provider, model, connected);
        entries.push({
          id: imageModelId(provider, model.id),
          provider,
          model: model.id,
          name: model.name,
          providerName: value.name,
          releaseDate: model.release_date ?? "",
          price: modelPrice(model.cost),
          outputFormat: outputFormat(model),
          connected,
          reason,
        });
      }
    }
    return entries;
  });
}

export function nativeSelection(entry: ImageModelEntry): ImageModelSelection {
  if (entry.reason || !Schema.is(ImageProvider)(entry.provider))
    throw new PersonaError("invalid", entry.reason || "지원하지 않는 공급자입니다.");
  return {
    id: entry.id,
    provider: entry.provider,
    model: entry.model,
    name: entry.name,
    providerName: entry.providerName,
    price: entry.price,
    outputFormat: entry.outputFormat,
    observedAt: Date.now(),
    referenceField: "image_urls",
    size: "default",
    fields: [],
  };
}
