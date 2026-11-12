import { Schema } from "effect";

export const RigArtworkModel = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const Dimension = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 10000 }),
);
export const RigLayerPlane = Schema.Literals([
  "behind-body",
  "body",
  "outfit",
  "face",
  "front-body",
  "front-face",
]);
export const RigFaceRole = Schema.Literals([
  "base",
  "eye-left",
  "eye-right",
  "pupil-left",
  "pupil-right",
  "lid-left",
  "lid-right",
  "brow-left",
  "brow-right",
  "mouth",
]);
export const RigFaceState = Schema.Literals([
  "neutral",
  "happy",
  "thinking",
  "worried",
  "surprised",
  "half",
  "closed",
  "open",
]);
export const RigFacePart = Schema.Struct({
  role: RigFaceRole,
  state: RigFaceState,
  imageUrl: Schema.String,
  closed: Schema.optionalKey(Schema.Boolean),
  bounds: Schema.optionalKey(
    Schema.Tuple([Schema.Number, Schema.Number, Schema.Number, Schema.Number]),
  ),
  aperture: Schema.optionalKey(
    Schema.Array(Schema.Tuple([Schema.Number, Schema.Number])).check(
      Schema.isMinLength(3),
      Schema.isMaxLength(64),
    ),
  ),
  gaze: Schema.optionalKey(
    Schema.Struct({
      x: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
      y: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
    }),
  ),
});
export type RigFacePart = typeof RigFacePart.Type;
export const RigFaceGenerationKind = Schema.Literals(["base", "closed", "surprised"]);
export const RigFaceSource = Schema.Struct({
  kind: RigFaceGenerationKind,
  operationId: Schema.String,
  model: RigArtworkModel,
  imageUrl: Schema.String,
  bounds: Schema.Tuple([Schema.Number, Schema.Number, Schema.Number, Schema.Number]),
});
export const RigArtworkLayer = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(160)),
  zIndex: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 16 })),
  imageUrl: Schema.String,
  width: Dimension,
  height: Dimension,
  bounds: Schema.Tuple([Schema.Number, Schema.Number, Schema.Number, Schema.Number]),
  plane: Schema.optionalKey(RigLayerPlane),
  bone: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32))),
});
export type RigArtworkLayer = typeof RigArtworkLayer.Type;
export const RigJointPositions = Schema.Array(
  Schema.Struct({
    name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32)),
    x: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
    y: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  }),
).check(Schema.isMaxLength(15));
export const RigArtworkLayers = Schema.Struct({
  operationId: Schema.String,
  generationOperationId: Schema.optionalKey(Schema.String),
  sourceRepair: Schema.optionalKey(Schema.Boolean),
  jointPositions: Schema.optionalKey(RigJointPositions),
  sourceOperationId: Schema.String,
  model: RigArtworkModel,
  width: Dimension,
  height: Dimension,
  layers: Schema.Array(RigArtworkLayer).check(Schema.isMinLength(2), Schema.isMaxLength(17)),
  faceParts: Schema.optionalKey(Schema.Array(RigFacePart).check(Schema.isMaxLength(40))),
  faceSources: Schema.optionalKey(Schema.Array(RigFaceSource).check(Schema.isMaxLength(12))),
});
export type RigArtworkLayers = typeof RigArtworkLayers.Type;
const RigArtworkAsset = Schema.Struct({
  model: RigArtworkModel,
  imageUrl: Schema.String,
  operationId: Schema.String,
  layers: Schema.optionalKey(RigArtworkLayers),
});
export const RigArtworkOutfit = Schema.Struct({
  ...RigArtworkAsset.fields,
  sourceOperationId: Schema.String,
});
export type RigArtworkOutfit = typeof RigArtworkOutfit.Type;
export const RigArtworkImage = Schema.Struct({
  ...RigArtworkAsset.fields,
  kind: Schema.optionalKey(Schema.Literal("body")),
  outfit: Schema.optionalKey(RigArtworkOutfit),
});
export type RigArtworkImage = typeof RigArtworkImage.Type;
