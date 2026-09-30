import { NodeServices } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import type { IncomingMessage, Messages } from "../messages/messages.ts";
import { imageMime } from "../intake/images.ts";

const reference = Schema.fromJsonString(
  Schema.Struct({
    handle: Schema.String,
    guid: Schema.String,
    index: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  }),
);

export const transportRow = (row: IncomingMessage): IncomingMessage => {
  if (!row.attachments) return row;
  return {
    ...row,
    attachments: row.attachments.map((attachment, index) => ({
      ...attachment,
      path: JSON.stringify({ handle: row.handle, guid: row.guid, index }),
    })),
  };
};

export const readAttachment = (messages: Messages, value: string) =>
  Effect.gen(function* () {
    const { handle, guid, index } = yield* Schema.decodeUnknownEffect(reference)(value);
    const rows = yield* messages.recent(handle, 0);
    const attachment = rows.find((row) => row.guid === guid)?.attachments?.[index];
    if (!attachment || attachment.missing || !imageMime(attachment))
      return yield* Effect.fail(new Error("Image unavailable"));
    return yield* messages.image(attachment).pipe(Effect.provide(NodeServices.layer));
  });
