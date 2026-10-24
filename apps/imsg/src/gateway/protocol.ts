import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

export const tapbacks = ["love", "like", "dislike", "laugh", "emphasis", "question"] as const;
export type Tapback = (typeof tapbacks)[number];
export const tapback = Schema.Literals(tapbacks);

export const outgoingStatus = Schema.Struct({
  delivered: Schema.Boolean,
  readAt: Schema.NullOr(Schema.Number),
});
export type OutgoingStatus = typeof outgoingStatus.Type;

const handle = { handle: Schema.String };
const guid = { guid: Schema.String };
const since = { ...handle, since: Schema.Number };
const cursor = {
  rowID: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
};
export const recentQuery = Schema.Struct({
  guid: Schema.optionalKey(Schema.String),
  after: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  before: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
  until: Schema.optionalKey(Schema.Number),
  limit: Schema.optionalKey(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(500),
    ),
  ),
  reverse: Schema.optionalKey(Schema.Boolean),
});
/** The optional parts of a message row beyond its text. */
export const messageDetail = Schema.Struct({
  attachments: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        mimeType: Schema.NullOr(Schema.String),
        uti: Schema.NullOr(Schema.String),
        missing: Schema.Boolean,
      }),
    ),
  ),
  tapback: Schema.optionalKey(
    Schema.Struct({
      emoji: Schema.String,
      targetGuid: Schema.String,
      added: Schema.Boolean,
    }),
  ),
  replyToGuid: Schema.optionalKey(Schema.String),
  payload: Schema.optionalKey(Schema.Literals(["location", "app"])),
});
export const incomingMessage = Schema.Struct({
  id: Schema.Number,
  guid: Schema.String,
  handle: Schema.String,
  createdAt: Schema.Number,
  text: Schema.String,
  fromMe: Schema.Boolean,
  ...messageDetail.fields,
});

const messageStatus = Schema.Struct({
  state: Schema.Literals(["pending", "sent", "delivered", "failed"]),
  error: Schema.Number,
  dateRead: Schema.NullOr(Schema.Number),
});

export const historyQuery = Schema.Struct({
  ...since,
  until: Schema.NullOr(Schema.Number),
  before: recentQuery.fields.before,
});
export const historyMessage = Schema.Struct({
  ...incomingMessage.fields,
  status: Schema.NullOr(messageStatus),
});

export const sendTextRpc = Rpc.make("sendText", {
  payload: { handle: Schema.String, text: Schema.String },
  success: Schema.Struct({ guid: Schema.NullOr(Schema.String) }),
  error: Schema.String,
});

export const messagingApi = RpcGroup.make(
  Rpc.make("history", {
    payload: historyQuery,
    success: Schema.Struct({ entries: Schema.Array(historyMessage), requestId: Schema.String }),
    error: Schema.String,
  }),
  Rpc.make("availability", {
    payload: handle,
    success: Schema.Struct({ available: Schema.Boolean, requestId: Schema.String }),
    error: Schema.String,
  }),
  Rpc.make("submitText", {
    payload: { ...handle, text: Schema.String, attemptID: Schema.String.check(Schema.isUUID()) },
    success: Schema.Struct({ guid: Schema.NullOr(Schema.String), requestId: Schema.String }),
    error: Schema.String,
  }),
  Rpc.make("resolveSend", {
    payload: { attemptID: Schema.String.check(Schema.isUUID()) },
    success: Schema.Struct({
      state: Schema.Literals(["sent", "delivered", "failed", "unknown"]),
      requestId: Schema.String,
    }),
    error: Schema.String,
  }),
  Rpc.make("notify", {
    payload: { handle: Schema.String, text: Schema.String },
    success: Schema.Struct({ guid: Schema.String, requestId: Schema.String }),
    error: Schema.String,
  }),
  Rpc.make("notificationStatus", { payload: guid, success: messageStatus, error: Schema.String }),
  Rpc.make("probe", { error: Schema.String }),
  Rpc.make("image", {
    payload: { reference: Schema.String },
    success: Schema.Struct({ uri: Schema.String }),
    error: Schema.String,
  }),
  sendTextRpc,
  Rpc.make("after", {
    payload: {
      ...cursor,
      limit: Schema.optionalKey(
        Schema.Number.check(
          Schema.isInt(),
          Schema.isGreaterThanOrEqualTo(1),
          Schema.isLessThanOrEqualTo(500),
        ),
      ),
    },
    success: Schema.Array(incomingMessage),
    error: Schema.String,
  }),
  Rpc.make("follow", {
    payload: { ...cursor, date: Schema.NullOr(Schema.Number) },
    success: Schema.NullOr(incomingMessage),
    stream: true,
    error: Schema.String,
  }),
  Rpc.make("recent", {
    payload: { ...since, ...recentQuery.fields },
    success: Schema.Array(incomingMessage),
    error: Schema.String,
  }),
  Rpc.make("status", {
    payload: guid,
    success: messageStatus,
    error: Schema.String,
  }),
  Rpc.make("sendStatus", {
    payload: guid,
    success: Schema.Literals(["sent", "delivered", "failed", "unknown"]),
    error: Schema.String,
  }),
  Rpc.make("textStatus", {
    payload: since,
    success: Schema.Literals(["sent", "no_imessage", "unknown"]),
    error: Schema.String,
  }),
  Rpc.make("lastOutgoingStatus", {
    payload: handle,
    success: Schema.UndefinedOr(outgoingStatus),
    error: Schema.String,
  }),
  Rpc.make("typing", {
    payload: {
      ...handle,
      text: Schema.String,
      durationMillis: Schema.Number.check(
        Schema.isGreaterThanOrEqualTo(0),
        Schema.isLessThanOrEqualTo(15000),
      ),
    },
    success: Schema.Boolean,
    error: Schema.String,
  }),
  Rpc.make("read", { payload: handle, error: Schema.String }),
  Rpc.make("react", { payload: { ...handle, tapback }, error: Schema.String }),
);
