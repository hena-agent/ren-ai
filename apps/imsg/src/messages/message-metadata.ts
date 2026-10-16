import { DatabaseSync } from "node:sqlite";
import { Context, Effect, Schema } from "effect";
import { observe } from "../diagnostics.ts";

const metadata = Schema.Struct({
  chatID: Schema.Number,
  guid: Schema.NullOr(Schema.String),
  createdAt: Schema.NullOr(Schema.Number),
});
type Metadata = typeof metadata.Type;

export class MessageMetadata extends Context.Service<
  MessageMetadata,
  {
    readonly lookup: (handle: string) => Effect.Effect<Metadata | undefined, Error>;
  }
>()("imsg/MessageMetadata") {}

/** Only routing/status metadata. imsg remains responsible for decoding Messages content. */
export const messageMetadata = (path: string) =>
  MessageMetadata.of({
    lookup: (handle) =>
      observe(
        "imsg.metadata.lookup",
        Effect.try(() => {
          // Open read-only per lookup: replaced chat.db files cannot leave stale cached ROWIDs.
          const db = new DatabaseSync(path, { readOnly: true });
          try {
            const row = db
              .prepare(`SELECT c.ROWID AS chatID, m.guid,
          m.date / 1000000.0 + 978307200000 AS createdAt
        FROM chat c LEFT JOIN message m ON m.ROWID = (
          SELECT MAX((SELECT j.message_id FROM chat_message_join j JOIN message outgoing
            ON outgoing.ROWID = j.message_id
            WHERE j.chat_id = matching.ROWID AND outgoing.is_from_me = 1
            ORDER BY j.message_id DESC LIMIT 1))
          FROM chat matching WHERE matching.chat_identifier = c.chat_identifier
        ) WHERE c.chat_identifier = ?
        ORDER BY (SELECT MAX(message_id) FROM chat_message_join WHERE chat_id = c.ROWID) DESC
        LIMIT 1`)
              .get(handle);
            return row === undefined ? undefined : Schema.decodeUnknownSync(metadata)(row);
          } finally {
            db.close();
          }
        }),
        () => ({}),
      ).pipe(
        Effect.mapError((error) => new Error("Messages metadata unavailable", { cause: error })),
      ),
  });
