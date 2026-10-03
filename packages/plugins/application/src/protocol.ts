import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

export const tapbacks = ["love", "like", "dislike", "laugh", "emphasis", "question"] as const;
export type Tapback = (typeof tapbacks)[number];
export const tapback = Schema.Literals(tapbacks);

const session = { sessionID: Schema.String };
export const persona = Schema.Struct({
  id: Schema.String,
  timeZone: Schema.String,
  language: Schema.String,
  openingLine: Schema.String,
  memory: Schema.String,
  prompt: Schema.String,
});

export type Persona = typeof persona.Type;
export const outgoingStatus = Schema.Struct({
  delivered: Schema.Boolean,
  readAt: Schema.NullOr(Schema.Number),
});
export type OutgoingStatus = typeof outgoingStatus.Type;

export const applicationApi = RpcGroup.make(
  Rpc.make("catalog", { success: Schema.Array(persona), error: Schema.String }),
  Rpc.make("send", {
    payload: { ...session, text: Schema.String, callID: Schema.String },
    success: Schema.String,
    error: Schema.String,
  }),
  Rpc.make("wait", {
    payload: { ...session, minutes: Schema.Number },
    success: Schema.String,
    stream: true,
    error: Schema.String,
  }),
  Rpc.make("read", {
    payload: session,
    success: Schema.String,
    error: Schema.String,
  }),
  Rpc.make("react", {
    payload: { ...session, tapback, callID: Schema.String },
    success: Schema.String,
    error: Schema.String,
  }),
  Rpc.make("handle", {
    payload: session,
    success: Schema.UndefinedOr(Schema.String),
    error: Schema.String,
  }),
  Rpc.make("context", { payload: session, error: Schema.String }),
  Rpc.make("status", {
    payload: session,
    success: Schema.UndefinedOr(outgoingStatus),
    error: Schema.String,
  }),
  Rpc.make("sends", {
    payload: session,
    success: Schema.Array(
      Schema.Struct({
        toolCallID: Schema.NullOr(Schema.String),
        state: Schema.String,
        updatedAt: Schema.Number,
      }),
    ),
    error: Schema.String,
  }),
  Rpc.make("alert", {
    payload: { name: Schema.String, detail: Schema.String },
    error: Schema.String,
  }),
);
