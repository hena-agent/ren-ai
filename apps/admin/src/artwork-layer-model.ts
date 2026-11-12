import { Schema } from "effect";
import { RigArtworkLayer } from "@ren-ai/personas/rig-artwork";

export const artworkLayerModel = "bytedance/seedream/v5/pro/layerize";
export const ArtworkLayerSelection = Schema.Struct({
  model: Schema.Literal(artworkLayerModel),
  sourceOperationId: Schema.String,
  resolution: Schema.Literal("auto_1.5K"),
  price: Schema.String,
  observedAt: Schema.Number,
});
export type ArtworkLayerSelection = typeof ArtworkLayerSelection.Type;
export const ArtworkLayerOptions = Schema.Struct({
  selection: ArtworkLayerSelection,
  quote: Schema.String,
});
const Bounds = Schema.Tuple([Schema.Number, Schema.Number, Schema.Number, Schema.Number]);
export const ArtworkLayerResponse = Schema.Struct({
  layers: Schema.Array(
    Schema.Struct({
      image: Schema.Struct({ url: Schema.String }),
      z_index: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 16 })),
      name: Schema.optionalKey(Schema.NullOr(Schema.String)),
      bounding_box: Schema.optionalKey(Schema.NullOr(Schema.Struct({ absolute: Bounds }))),
    }),
  ).check(Schema.isMinLength(2), Schema.isMaxLength(17)),
});
export type ArtworkLayerResponse = typeof ArtworkLayerResponse.Type;
export const ArtworkLayerCheckpoint = Schema.Struct({
  requestId: Schema.optionalKey(Schema.String),
  response: Schema.optionalKey(ArtworkLayerResponse),
  saved: Schema.Array(RigArtworkLayer),
});
export type ArtworkLayerCheckpoint = typeof ArtworkLayerCheckpoint.Type;
