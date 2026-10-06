import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

const handle = { handle: Schema.String };
const guid = { guid: Schema.String };
const since = { ...handle, since: Schema.Number };
const cursor = {
  rowID: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
};
import { tapback, outgoingStatus } from "@ren-ai/plugin-application/protocol";
export { tapback };
const message = Schema.Struct({
  id: Schema.Number,
  guid: Schema.String,
  handle: Schema.String,
  createdAt: Schema.Number,
  text: Schema.String,
  fromMe: Schema.Boolean,
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

export const messagingApi = RpcGroup.make(
  Rpc.make("probe", { error: Schema.String }),
  Rpc.make("image", {
    payload: { reference: Schema.String },
    success: Schema.Struct({ uri: Schema.String }),
    error: Schema.String,
  }),
  Rpc.make("sendText", {
    payload: { handle: Schema.String, text: Schema.String },
    success: Schema.Struct({ guid: Schema.NullOr(Schema.String) }),
    error: Schema.String,
  }),
  Rpc.make("after", {
    payload: cursor,
    success: Schema.Array(message),
    error: Schema.String,
  }),
  Rpc.make("follow", {
    payload: { ...cursor, date: Schema.NullOr(Schema.Number) },
    success: Schema.NullOr(message),
    stream: true,
    error: Schema.String,
  }),
  Rpc.make("recent", {
    payload: since,
    success: Schema.Array(message),
    error: Schema.String,
  }),
  Rpc.make("status", {
    payload: guid,
    success: Schema.Struct({
      state: Schema.Literals(["pending", "sent", "delivered", "failed"]),
      error: Schema.Number,
      dateRead: Schema.NullOr(Schema.Number),
    }),
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
