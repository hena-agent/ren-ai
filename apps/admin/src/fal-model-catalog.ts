import { Schema } from "effect";
import { PersonaError } from "@ren-ai/personas";
import { imageModelId, type ImageModelEntry, type ImageModelSelection } from "./image-model.ts";
import { catalogJson } from "./image-model-source.ts";

const Metadata = Schema.Struct({
  display_name: Schema.String,
  category: Schema.String,
  status: Schema.String,
  date: Schema.optionalKey(Schema.String),
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
});
const Listing = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({ endpoint_id: Schema.String, metadata: Schema.optionalKey(Metadata) }),
  ),
  next_cursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const Property = Schema.Struct({
  $ref: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.String),
  minItems: Schema.optionalKey(Schema.Number),
  maxItems: Schema.optionalKey(Schema.Number),
  minimum: Schema.optionalKey(Schema.Number),
  maximum: Schema.optionalKey(Schema.Number),
  enum: Schema.optionalKey(
    Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null])),
  ),
  anyOf: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        $ref: Schema.optionalKey(Schema.String),
        type: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});
const Shape = Schema.Struct({
  $ref: Schema.optionalKey(Schema.String),
  required: Schema.optionalKey(Schema.Array(Schema.String)),
  properties: Schema.optionalKey(Schema.Record(Schema.String, Property)),
});
const Content = Schema.Struct({ "application/json": Schema.Struct({ schema: Shape }) });
const Api = Schema.Struct({
  components: Schema.Struct({ schemas: Schema.Record(Schema.String, Shape) }),
  paths: Schema.Record(
    Schema.String,
    Schema.Struct({
      post: Schema.optionalKey(Schema.Struct({ requestBody: Schema.Struct({ content: Content }) })),
      get: Schema.optionalKey(
        Schema.Struct({
          responses: Schema.Record(
            Schema.String,
            Schema.Struct({ content: Schema.optionalKey(Content) }),
          ),
        }),
      ),
    }),
  ),
});
const Pricing = Schema.Struct({
  prices: Schema.Array(
    Schema.Struct({
      endpoint_id: Schema.String,
      unit_price: Schema.Number,
      unit: Schema.String,
      currency: Schema.String,
    }),
  ),
});

function artworkModel(model: string, metadata: typeof Metadata.Type) {
  return (
    !metadata.tags?.includes("utility") &&
    !/(?:^|\/)(?:layerize|upscale|virtual-try-on|product-holding|increase-resolution)(?:\/|$)/.test(
      model,
    )
  );
}

function modelName(model: string, name: string) {
  const version = /\/v(\d+(?:\.\d+)?)\/([^/]+)\//.exec(model);
  if (!version || /\d/.test(name)) return name;
  const tier = version[2]!;
  return `${name} ${version[1]} · ${tier.charAt(0).toUpperCase()}${tier.slice(1)}`;
}

export async function falEntries(
  key: string,
  fetcher: typeof fetch,
  query: string,
  cursor: string | null,
) {
  const params = new URLSearchParams({
    category: "image-to-image",
    status: "active",
    sort: "recent",
    limit: "50",
  });
  if (query) params.set("q", query);
  if (cursor) params.set("cursor", cursor);
  const page = await catalogJson(`https://api.fal.ai/v1/models?${params}`, Listing, fetcher, key);
  const models: ImageModelEntry[] = page.models.flatMap(({ endpoint_id, metadata }) =>
    metadata && artworkModel(endpoint_id, metadata)
      ? [
          {
            id: imageModelId("fal", endpoint_id),
            provider: "fal",
            model: endpoint_id,
            name: modelName(endpoint_id, metadata.display_name),
            providerName: "fal",
            releaseDate: metadata.date ?? "",
            price: "선택 시 현재 단가·참조 규격 조회",
            outputFormat: "png",
            connected: Boolean(key.trim()),
            reason: key.trim() ? "" : "FAL_KEY 미연결",
          },
        ]
      : [],
  );
  return { models, nextCursor: page.next_cursor ?? null };
}

function schemaOf(api: typeof Api.Type, shape: typeof Shape.Type) {
  if (!shape.$ref) return shape;
  const name = shape.$ref.split("/").at(-1)!;
  const result = api.components.schemas[name];
  if (!result) throw new PersonaError("invalid", "입력 스키마를 해석할 수 없습니다.");
  return result;
}

function supportsOne(property: typeof Property.Type | undefined) {
  return Boolean(property && (property.minimum ?? 1) <= 1 && (property.maximum ?? 1) >= 1);
}

function verifiedFields(
  input: typeof Shape.Type,
  output: typeof Shape.Type,
  referenceField: "image_url" | "image_urls",
) {
  const props = input.properties ?? {};
  const reference = props[referenceField];
  if (
    !reference ||
    (reference.minItems ?? 1) > 1 ||
    (reference.maxItems ?? 1) < 1 ||
    !props["sync_mode"] ||
    !output.properties?.["images"] ||
    !supportsOne(props["num_images"])
  )
    throw new PersonaError(
      "invalid",
      "이 모델은 시트 1장 참조·단일 인라인 이미지 생성 규격과 호환되지 않습니다.",
    );
  const fields = [
    "prompt",
    referenceField,
    "image_size",
    "aspect_ratio",
    "num_images",
    "max_images",
    "sequential_image_generation",
    "output_format",
    "sync_mode",
  ].filter((field) => Boolean(props[field]));
  if ((input.required ?? []).some((field) => !fields.includes(field)))
    throw new PersonaError("invalid", "이 모델에는 지원하지 않는 필수 입력이 있습니다.");
  if (props["max_images"] && !supportsOne(props["max_images"]))
    throw new PersonaError("invalid", "이 모델은 출력 한 장으로 제한할 수 없습니다.");
  return fields;
}

function verifiedFormat(props: Readonly<Record<string, typeof Property.Type>>) {
  if (props["output_format"]?.enum && !props["output_format"].enum.includes("png"))
    throw new PersonaError("invalid", "이 모델의 PNG 출력 옵션을 지원하지 않습니다.");
  if (props["sync_mode"]?.enum && !props["sync_mode"].enum.includes(true))
    throw new PersonaError("invalid", "인라인 이미지 응답을 지원하지 않습니다.");
  if (
    props["sequential_image_generation"]?.enum &&
    !props["sequential_image_generation"].enum.includes("disabled")
  )
    throw new PersonaError("invalid", "자동 다중 이미지 생성을 끌 수 없습니다.");
}

function pixelProperty(
  api: typeof Api.Type,
  property: { readonly $ref?: string; readonly type?: string },
) {
  if (property.type === "object") return true;
  if (!property.$ref) return false;
  const target = api.components.schemas[property.$ref.split("/").at(-1)!];
  return Boolean(target?.properties?.["width"] && target.properties["height"]);
}

function verifiedSize(
  api: typeof Api.Type,
  input: typeof Shape.Type,
  props: Readonly<Record<string, typeof Property.Type>>,
) {
  const pixels = props["image_size"];
  if (
    pixels &&
    (pixelProperty(api, pixels) || pixels.anyOf?.some((option) => pixelProperty(api, option)))
  )
    return "pixels";
  if ((input.required ?? []).includes("image_size"))
    throw new PersonaError("invalid", "이 모델의 필수 이미지 크기 규격은 아직 지원하지 않습니다.");
  const ratio = props["aspect_ratio"];
  return ratio && (!ratio.enum || ratio.enum.includes("2:3")) ? "ratio" : "default";
}

function falContract(api: typeof Api.Type, model: string) {
  const request = api.paths[`/${model}`]?.post?.requestBody.content["application/json"].schema;
  const response =
    api.paths[`/${model}/requests/{request_id}`]?.get?.responses["200"]?.content?.[
      "application/json"
    ].schema;
  if (!request || !response)
    throw new PersonaError("invalid", "지원하는 이미지 요청·응답 규격이 없습니다.");
  const input = schemaOf(api, request);
  const props = input.properties ?? {};
  const referenceField = props["image_urls"] ? "image_urls" : "image_url";
  const fields = verifiedFields(input, schemaOf(api, response), referenceField);
  verifiedFormat(props);
  const size = verifiedSize(api, input, props);
  if ((input.required ?? []).includes("aspect_ratio") && size !== "ratio")
    throw new PersonaError("invalid", "지원하지 않는 필수 화면 비율입니다.");
  return { referenceField, size, fields } as const;
}

export async function falSelection(
  model: string,
  key: string,
  fetcher: typeof fetch,
): Promise<ImageModelSelection> {
  if (!key.trim()) throw new PersonaError("invalid", "FAL_KEY를 설정하세요.");
  const params = new URLSearchParams({ endpoint_id: model });
  const page = await catalogJson(`https://api.fal.ai/v1/models?${params}`, Listing, fetcher, key);
  const entry = page.models.find((candidate) => candidate.endpoint_id === model);
  if (entry?.metadata?.status !== "active" || entry.metadata.category !== "image-to-image")
    throw new PersonaError("invalid", "활성 이미지 편집 모델을 선택하세요.");
  if (!artworkModel(model, entry.metadata))
    throw new PersonaError("invalid", "이 모델은 전신 원화 생성이 아닌 다른 이미지 작업용입니다.");
  const api = await catalogJson(
    `https://fal.ai/api/openapi/queue/openapi.json?${params}`,
    Api,
    fetcher,
  );
  const contract = falContract(api, model);
  const prices = await catalogJson(
    `https://api.fal.ai/v1/models/pricing?${params}`,
    Pricing,
    fetcher,
    key,
  );
  const price = prices.prices.find((candidate) => candidate.endpoint_id === model);
  return {
    id: imageModelId("fal", model),
    provider: "fal",
    model,
    name: modelName(model, entry.metadata.display_name),
    providerName: "fal",
    price: price
      ? `${price.currency} ${price.unit_price} / ${price.unit} · 입력·해상도별 추가 요금은 공급자 규칙 적용`
      : "단가 정보 없음 · 공급자 문서 확인",
    observedAt: Date.now(),
    outputFormat: "png",
    ...contract,
  };
}
