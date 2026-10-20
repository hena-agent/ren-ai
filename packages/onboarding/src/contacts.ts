import { Schema } from "effect";
import { PublicLanguages } from "@ren-ai/personas/languages";

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
export const ContactEntry = Schema.Struct({
  id: identifier,
  handle: Schema.String,
  createdAt: Schema.Number,
  likedPersonas: Schema.Array(candidate),
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
  imessage: Schema.optionalKey(
    Schema.Struct({
      status: Schema.Literals(["available", "unavailable", "failed"]),
      checkedAt: Schema.Number,
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
});
export const StartContact = Schema.Struct({
  requestId: identifier,
  registrationID: identifier,
  personaID: Schema.String.check(Schema.isNonEmpty()),
});
export const ContactSelection = Schema.Struct({
  requestId: identifier,
  requested: Schema.Number,
  entries: Schema.Array(ContactEntry),
});
