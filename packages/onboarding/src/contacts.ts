import { Schema } from "effect";

const identifier = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
);
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
  reason: Schema.Literals(["ready", "blocked", "active", "reserved", "no_persona"]),
  persona: Schema.NullOr(candidate),
  scheduledAt: Schema.NullOr(Schema.Number),
  requestId: Schema.NullOr(Schema.String),
  testHandle: Schema.optionalKey(Schema.Boolean),
});
export const ContactSnapshot = Schema.Struct({
  entries: Schema.Array(ContactEntry),
  eligibleCount: Schema.Number,
});
export const SelectContacts = Schema.Struct({
  requestId: identifier,
  count: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 })),
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
