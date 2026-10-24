import { Schema } from "effect";
import { DiscoveryLocale, PublicPersona, ReselectionRequest } from "./discovery.ts";

export const BrowseQuery = Schema.Struct({
  locale: DiscoveryLocale,
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
});
export type BrowseQuery = typeof BrowseQuery.Type;
export const BrowsePage = Schema.Struct({
  people: Schema.Array(PublicPersona).check(Schema.isMaxLength(10)),
  nextCursor: Schema.NullOr(Schema.String),
});
export type BrowsePage = typeof BrowsePage.Type;
export const BrowseReselection = Schema.Struct({
  ...BrowseQuery.fields,
  ...ReselectionRequest.fields,
});
export const ProfileLookup = Schema.Struct({
  ids: Schema.Array(PublicPersona.fields.id).check(Schema.isMaxLength(100), Schema.isUnique()),
  reselectionToken: Schema.optionalKey(ReselectionRequest.fields.reselectionToken),
});
export const PersonaLink = Schema.Struct({
  id: PublicPersona.fields.id,
  imageUrl: PublicPersona.fields.imageUrl,
});
