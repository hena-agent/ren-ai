import { Schema } from "effect";
import { PublicLanguages } from "@ren-ai/personas/languages";
import { InvitationTicket } from "./invitation-code.ts";

const identifier = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
);
export const ConversationLanguages = Schema.Struct({
  languages: Schema.optionalKey(PublicLanguages),
  lastStateChange: Schema.optionalKey(Schema.Struct({ reason: Schema.String, at: Schema.String })),
});
export const ContactState = Schema.Literals([
  "waiting",
  "scheduled",
  "preparing",
  "greeting",
  "active",
  "failed",
  "review",
  "blocked",
  "unreachable",
]);
const candidate = Schema.Struct({ id: Schema.String, name: Schema.String });
export const InvitationSettings = Schema.Struct({ enabled: Schema.Boolean });
export const ContactEntry = Schema.Struct({
  id: identifier,
  handle: Schema.String,
  createdAt: Schema.Number,
  likedPersonas: Schema.Array(candidate),
  assignablePersonas: Schema.optionalKey(Schema.Array(candidate)),
  state: ContactState,
  eligible: Schema.Boolean,
  reason: Schema.Literals([
    "ready",
    "blocked",
    "active",
    "reserved",
    "no_persona",
    "no_imessage",
    "imessage_unverified",
  ]),
  persona: Schema.NullOr(candidate),
  scheduledAt: Schema.NullOr(Schema.Number),
  requestId: Schema.NullOr(Schema.String),
  testHandle: Schema.optionalKey(Schema.Boolean),
  hidden: Schema.optionalKey(Schema.Boolean),
  invitations: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        token: InvitationTicket.fields.token,
        redeemedAt: InvitationTicket.fields.redeemedAt,
        maxUses: InvitationTicket.fields.maxUses,
        grantCount: InvitationTicket.fields.grantCount,
        usedCount: InvitationTicket.fields.usedCount,
      }),
    ),
  ),
  imessage: Schema.optionalKey(
    Schema.Struct({
      status: Schema.Literals(["available", "unavailable", "failed"]),
      checkedAt: Schema.Number,
      reason: Schema.optionalKey(Schema.String),
    }),
  ),
  notification: Schema.optionalKey(
    Schema.Literals(["queued", "sent", "failed", "uncertain", "skipped"]),
  ),
  relationshipEnd: Schema.optionalKey(
    Schema.Struct({ at: Schema.Number, noticeDelivered: Schema.Boolean }),
  ),
});
export const ContactSnapshot = Schema.Struct({
  entries: Schema.Array(ContactEntry),
  eligibleCount: Schema.Number,
  invitationSettings: Schema.optionalKey(InvitationSettings),
  invitationCodes: Schema.optionalKey(Schema.Array(InvitationTicket)),
});
export const SelectContacts = Schema.Struct({
  requestId: identifier,
  count: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 })),
  registrationIDs: Schema.optionalKey(
    Schema.Array(identifier).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(100),
      Schema.isUnique(),
    ),
  ),
  assignments: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        registrationID: identifier,
        personaID: Schema.String.check(Schema.isNonEmpty()),
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  ),
});
export const StartContact = Schema.Struct({
  requestId: identifier,
  registrationID: identifier,
  personaID: Schema.String.check(Schema.isNonEmpty()),
});
export const ContactRecheck = Schema.Struct({ registrationID: identifier });
export const ContactVisibility = Schema.Struct({
  registrationIDs: Schema.Array(identifier).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
    Schema.isUnique(),
  ),
  hidden: Schema.Boolean,
});
export const ContactSelection = Schema.Struct({
  requestId: identifier,
  requested: Schema.Number,
  entries: Schema.Array(ContactEntry),
});
