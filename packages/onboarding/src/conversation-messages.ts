import { Schema } from "effect";
import { historyMessage } from "@ren-ai/imsg/protocol";

export const ConversationMessages = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      id: historyMessage.fields.id,
      guid: historyMessage.fields.guid,
      createdAt: historyMessage.fields.createdAt,
      text: historyMessage.fields.text,
      fromMe: historyMessage.fields.fromMe,
      status: historyMessage.fields.status,
      attachments: Schema.Array(
        Schema.Struct({
          mimeType: Schema.NullOr(Schema.String),
          missing: Schema.Boolean,
        }),
      ),
      tapback: historyMessage.fields.tapback,
      replyToGuid: historyMessage.fields.replyToGuid,
      payload: historyMessage.fields.payload,
    }),
  ),
  nextBefore: Schema.NullOr(Schema.Number),
});
