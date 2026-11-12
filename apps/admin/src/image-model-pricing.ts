import { Schema } from "effect";

const Price = Schema.Struct({
  price: Schema.Number,
  unit: Schema.optionalKey(Schema.String),
  overrides: Schema.optionalKey(Schema.Array(Schema.Struct({}))),
});
const Modality = Schema.Struct({
  input: Schema.optionalKey(Price),
  output: Schema.optionalKey(Price),
});
export const ModelCost = Schema.Struct({
  image: Schema.optionalKey(Modality),
  text: Schema.optionalKey(Modality),
});

export function modelPrice(cost: typeof ModelCost.Type | undefined) {
  if (!cost) return "단가 정보 없음 · 무료를 뜻하지 않습니다";
  const parts: string[] = [];
  for (const [name, prices] of [
    ["이미지", cost.image],
    ["텍스트", cost.text],
  ] as const) {
    for (const [direction, price] of [
      ["입력", prices?.input],
      ["출력", prices?.output],
    ] as const) {
      if (!price) continue;
      const unit = price.unit ?? "token";
      parts.push(
        `${name} ${direction} $${price.price} / ${unit === "token" || unit === "character" ? `100만 ${unit}` : unit}${price.overrides?.length ? " (옵션별 요금 있음)" : ""}`,
      );
    }
  }
  if (!cost.image) parts.push("이미지 별도 요금은 공급자 문서 확인");
  return parts.length ? parts.join(" · ") : "단가 정보 없음 · 무료를 뜻하지 않습니다";
}
