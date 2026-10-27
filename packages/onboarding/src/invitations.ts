import { Schema } from "effect";
import { MobileNumber } from "./shapes.ts";
import { DiscoveryLocale } from "./discovery.ts";

export const InvitationLookup = Schema.Struct({ handle: MobileNumber });
export const InvitationGrant = Schema.Struct({
  ...InvitationLookup.fields,
  requestId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)),
  kind: Schema.Literals(["basic", "extra"]),
  locale: DiscoveryLocale,
});
export const InvitationAccount = Schema.Struct({
  handle: MobileNumber,
  basicGranted: Schema.Boolean,
  extraCount: Schema.Number,
  invitations: Schema.Array(
    Schema.Struct({
      token: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
      createdAt: Schema.Number,
      redeemedAt: Schema.NullOr(Schema.Number),
      kind: InvitationGrant.fields.kind,
      state: Schema.Literals(["queued", "sent", "failed", "uncertain", "skipped"]),
    }),
  ),
});
