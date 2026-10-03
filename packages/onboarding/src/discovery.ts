import { Schema } from "effect";
import { OnboardingRequest } from "./shapes.ts";
import disclosure from "./discovery-notice.json";

export const discoveryNotice = disclosure;

const text = Schema.String.check(Schema.isNonEmpty());
const id = text.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/));
const photo = Schema.String.pipe(
  Schema.refine(
    (value): value is string =>
      /^\/discovery\/images\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(?:png|jpg|webp)$/.test(
        value,
      ) ||
      (URL.canParse(value) && new URL(value).protocol === "https:"),
  ),
);

export const PublicPersona = Schema.Struct({
  id,
  name: text,
  bio: text,
  imageUrl: photo,
  portraits: Schema.optionalKey(Schema.Struct({ anime: photo, photo })),
});
export type PublicPersona = typeof PublicPersona.Type;

export const DiscoveryRequest = Schema.Struct({
  ...OnboardingRequest.fields,
  likedPersonaIDs: Schema.Array(id).check(Schema.isMinLength(1), Schema.isUnique()),
});
export type DiscoveryRequest = typeof DiscoveryRequest.Type;
export const DiscoveryAnswer = Schema.Struct({ status: Schema.Literals(["waiting", "active"]) });
export type DiscoveryAnswer = typeof DiscoveryAnswer.Type;
