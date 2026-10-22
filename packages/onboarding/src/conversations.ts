import { Schema } from "effect";
import { StartingRelationship } from "./relationship.ts";

const id = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
export const ConversationQuery = Schema.Struct({
  filter: Schema.Literals(["active", "ended", "all"]),
  search: Schema.String.check(Schema.isMaxLength(100)),
  before: Schema.optionalKey(id),
});
export const ConversationRecovery = Schema.Struct({
  id,
  requestId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)),
  action: Schema.Literals(["stop", "farewell", "notice"]),
});
const delivery = Schema.Literals([
  "queued",
  "uncertain",
  "sent",
  "delivered",
  "failed",
  "cancelled",
]);
export const ConversationEntry = Schema.Struct({
  id,
  startingRelationship: Schema.optionalKey(StartingRelationship),
  handle: Schema.String,
  personaID: Schema.String,
  personaName: Schema.String,
  sessionID: Schema.String,
  startedAt: Schema.Number,
  endedAt: Schema.NullOr(Schema.Number),
  stoppedAt: Schema.NullOr(Schema.Number),
  canNotify: Schema.Boolean,
  lastReceivedAt: Schema.NullOr(Schema.Number),
  lastSentAt: Schema.NullOr(Schema.Number),
  farewell: delivery,
  notice: delivery,
});
export const ConversationList = Schema.Struct({
  entries: Schema.Array(ConversationEntry),
  nextBefore: Schema.NullOr(id),
});
export const ConversationRuntime = Schema.Struct({
  state: Schema.Literals(["running", "idle", "missing", "unavailable"]),
  failed: Schema.optionalKey(Schema.Boolean),
  pending: Schema.NullOr(Schema.Number),
  nextWakeAt: Schema.NullOr(Schema.Number),
});
export const ConversationDetail = Schema.Struct({
  entry: ConversationEntry,
  history: Schema.Array(ConversationEntry),
  registrationNextBefore: Schema.optionalKey(Schema.String),
  registrations: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      createdAt: Schema.Number,
      archivedAt: Schema.NullOr(Schema.Number),
      personaID: Schema.NullOr(Schema.String),
      state: Schema.NullOr(Schema.String),
      selectionID: Schema.NullOr(Schema.String),
    }),
  ),
});
