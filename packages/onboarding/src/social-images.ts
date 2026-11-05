import { Schema } from "effect";
import { SocialDiagnostic } from "./social-diagnostics.ts";

const id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,80}$/));
const integer = (max: number) =>
  Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: max }));
export const SocialImagePolicy = Schema.Struct({
  enabled: Schema.Boolean,
  credits: integer(10000),
  style: Schema.Literals(["anime", "photo"]),
});
export type SocialImagePolicy = typeof SocialImagePolicy.Type;
export const SocialImage = Schema.Struct({
  id,
  accountId: id,
  personaId: id,
  generation: Schema.Number,
  kind: Schema.Literals(["self", "creation"]),
  style: Schema.Literals(["anime", "photo"]),
  state: Schema.Literals([
    "skipped",
    "queued",
    "generating",
    "ready",
    "approved",
    "rejected",
    "publishing",
    "posted",
    "failed",
    "uncertain",
    "expired",
  ]),
  probability: integer(10000),
  roll: integer(9999),
  kindRoll: integer(9999),
  createdAt: Schema.Number,
  storageFailures: Schema.optionalKey(integer(3)),
  diagnostic: Schema.optionalKey(SocialDiagnostic),
});
export type SocialImage = typeof SocialImage.Type;
export const SocialImageData = Schema.Struct({
  id,
  data: Schema.String.check(Schema.isMaxLength(14000000)),
  mime: Schema.Literal("image/jpeg"),
});
export type SocialImageData = typeof SocialImageData.Type;
