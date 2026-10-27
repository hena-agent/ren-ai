import { Schema } from "effect";

export const InvitationCode = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/));
export const InvitationRules = Schema.Struct({
  maxUses: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 10000 })),
  grantCount: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 100 })),
});
export const InvitationCreate = Schema.Struct({
  requestId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)),
  code: Schema.optionalKey(InvitationCode),
  ...InvitationRules.fields,
});
export const InvitationTicket = Schema.Struct({
  token: InvitationCode,
  createdAt: Schema.Number,
  redeemedAt: Schema.NullOr(Schema.Number),
  // Optional until the API deployment supplies usage accounting to existing clients.
  maxUses: Schema.optionalKey(InvitationRules.fields.maxUses),
  grantCount: Schema.optionalKey(InvitationRules.fields.grantCount),
  usedCount: Schema.optionalKey(Schema.Number),
});
