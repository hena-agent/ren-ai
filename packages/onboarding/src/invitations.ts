import { Schema } from "effect";
import { MobileNumber } from "./shapes.ts";
import { DiscoveryLocale } from "./discovery.ts";
import { InvitationRules, InvitationTicket } from "./invitation-code.ts";

export const InvitationLookup = Schema.Struct({ handle: MobileNumber });
export const InvitationGrant = Schema.Struct({
  ...InvitationLookup.fields,
  requestId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)),
  kind: Schema.Literals(["basic", "extra"]),
  locale: DiscoveryLocale,
  maxUses: Schema.optionalKey(InvitationRules.fields.maxUses),
  grantCount: Schema.optionalKey(InvitationRules.fields.grantCount),
});
export const InvitationAccount = Schema.Struct({
  handle: MobileNumber,
  basicGranted: Schema.Boolean,
  extraCount: Schema.Number,
  invitations: Schema.Array(
    Schema.Struct({
      ...InvitationTicket.fields,
      kind: InvitationGrant.fields.kind,
      state: Schema.Literals(["queued", "sent", "failed", "uncertain", "skipped"]),
    }),
  ),
});
