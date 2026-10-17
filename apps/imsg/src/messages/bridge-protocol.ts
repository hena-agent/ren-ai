import { Schema } from "effect";

const base = {
  guid: Schema.String,
  sender: Schema.NullOr(Schema.String),
  participants: Schema.NullOr(Schema.Array(Schema.String)),
  sentAt: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
};

const bridgeMessage = Schema.Union([
  Schema.Struct({
    ...base,
    kind: Schema.Literal("text"),
    text: Schema.String,
    attachments: Schema.Array(
      Schema.Struct({
        path: Schema.NullOr(Schema.String),
        mime: Schema.String,
        uti: Schema.String,
      }),
    ),
    replyTo: Schema.NullOr(Schema.String),
    payload: Schema.NullOr(Schema.Literals(["location", "app"])),
  }),
  Schema.Struct({
    ...base,
    kind: Schema.Literal("tapback"),
    target: Schema.String,
    emoji: Schema.String,
    added: Schema.Boolean,
  }),
  Schema.Struct({
    ...base,
    kind: Schema.Literal("edit"),
    target: Schema.String,
    text: Schema.String,
  }),
  Schema.Struct({ ...base, kind: Schema.Literal("unsend"), target: Schema.String }),
  Schema.Struct({ ...base, kind: Schema.Literal("delivered") }),
  Schema.Struct({ ...base, kind: Schema.Literal("read") }),
]);

/** A decoded notification as the native bridge reports it, before relevance filtering. */
export type BridgeMessage = typeof bridgeMessage.Type;

const result = Schema.Union([
  Schema.Struct({ handles: Schema.Array(Schema.String) }),
  Schema.Struct({ status: Schema.Literal("sent") }),
  Schema.Struct({ status: Schema.Literal("failed"), code: Schema.String }),
  Schema.Struct({ acknowledged: Schema.Boolean }),
]);

export type BridgeResult = typeof result.Type;

const frame = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ id: Schema.Number, result }),
    Schema.Struct({
      id: Schema.Number,
      error: Schema.Struct({
        stage: Schema.String,
        cause: Schema.Record(
          Schema.String,
          Schema.NullOr(Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
        ),
      }),
    }),
    Schema.Struct({
      event: Schema.Literal("message"),
      spool: Schema.String,
      message: bridgeMessage,
    }),
  ]),
);

/** The only entry point for bytes printed by the native bridge. */
export const parseFrame = Schema.decodeUnknownSync(frame);
