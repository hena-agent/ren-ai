import { outgoingStatus, tapback } from "@ren-ai/imsg/protocol";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

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

export const applicationApi = RpcGroup.make(
  Rpc.make("observe", { payload: session, error: Schema.String }),
  Rpc.make("catalog", { success: Schema.Array(persona), error: Schema.String }),
  Rpc.make("send", {
    payload: { ...session, text: Schema.String, callID: Schema.String },
    success: Schema.String,
    error: Schema.String,
  }),
  Rpc.make("endConversation", {
    payload: { ...session, farewell: Schema.String, callID: Schema.String },
    success: Schema.String,
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
  Rpc.make("context", {
    payload: { ...session, messageIDs: Schema.Array(Schema.String) },
    success: Schema.Struct({
      status: Schema.UndefinedOr(outgoingStatus),
      sends: Schema.Array(
        Schema.Struct({
          toolCallID: Schema.NullOr(Schema.String),
          state: Schema.String,
          updatedAt: Schema.Number,
        }),
      ),
    }),
    error: Schema.String,
  }),
  Rpc.make("alert", {
    payload: { name: Schema.String, detail: Schema.String },
    error: Schema.String,
  }),
);
