import type { Effect } from "effect";
import type { OutgoingStatus, recentQuery } from "../gateway/protocol.ts";

/** The adapter must force iMessage and must never fall back to SMS. */
export interface Messages {
  availability(
    handle: string,
    requestId?: string,
  ): Effect.Effect<{ readonly available: boolean }, Error>;
  image(
    attachment: NonNullable<IncomingMessage["attachments"]>[number],
  ): Effect.Effect<{ readonly uri: string }, Error>;
  sendText(
    handle: string,
    text: string,
    attemptID?: string,
    requestId?: string,
  ): Effect.Effect<{ readonly guid: string | null }, Error>;
  /** Atomically reject a missing application-owned attempt; never retry an admitted send. */
  resolveSend(attemptID: string): Effect.Effect<"sent" | "delivered" | "failed" | "unknown", Error>;
  /** Status of her most recent outgoing row, using its date_read and delivery fields. */
  lastOutgoingStatus(handle: string): Effect.Effect<OutgoingStatus | undefined, Error>;
  /** Ordered by ROWID. Older deployed gateways may return more than the optional limit. */
  after(rowID: number, limit?: number): Effect.Effect<ReadonlyArray<IncomingMessage>, Error>;
  /** All rows in this Handle's chat since the timestamp, including empty (unsent) texts. */
  recent(
    handle: string,
    since: number,
    query?: typeof recentQuery.Type,
  ): Effect.Effect<ReadonlyArray<IncomingMessage>, Error>;
  /** The final status of an outgoing Messages row; error 22 is failed, not sent. */
  sendStatus(guid: string): Effect.Effect<"sent" | "delivered" | "failed" | "unknown", Error>;
  follow(
    rowID: number,
    receive: (row: IncomingMessage) => Effect.Effect<void, Error>,
  ): Effect.Effect<() => void, Error>;
  /** The latest outcome of a Notice attempted at or after since, even when imsg returned no GUID. */
  textStatus(
    handle: string,
    since: number,
  ): Effect.Effect<"sent" | "no_imessage" | "unknown", Error>;
  /** Status of a particular outgoing row; an absent row is still pending. */
  status(guid: string): Effect.Effect<MessageStatus, Error>;
}

/** Service-authored texts have no Conversation and no incoming-message feed. */
export interface Notifications {
  sendText(
    handle: string,
    text: string,
    requestId: string,
  ): Effect.Effect<{ readonly guid: string }, Error>;
  status: Messages["status"];
  probe(): Effect.Effect<void, Error>;
}

interface MessageStatus {
  readonly state: "pending" | "sent" | "delivered" | "failed";
  readonly error: number;
  readonly dateRead: number | null;
}

export interface IncomingMessage {
  readonly id: number;
  readonly guid: string;
  readonly handle: string;
  readonly createdAt: number;
  readonly text: string;
  readonly fromMe: boolean;
  /** imsg attachments: original_path, mime_type, uti, missing. */
  readonly attachments?: ReadonlyArray<{
    readonly path: string;
    readonly mimeType: string | null;
    readonly uti: string | null;
    readonly missing: boolean;
  }>;
  /** imsg is_reaction, reaction_emoji, is_reaction_add and reacted_to_guid. */
  readonly tapback?: {
    readonly emoji: string;
    readonly targetGuid: string;
    readonly added: boolean;
  };
  /** imsg thread_originator_guid (NOT reply_to_guid, which is set on ordinary messages). */
  readonly replyToGuid?: string;
  /** Non-attachment iMessage payloads identified by the adapter. */
  readonly payload?: "location" | "app";
}

/** Accept complete responses from older Macs while newer ones push these bounds into SQL. */
export const selectRecent = (
  rows: readonly IncomingMessage[],
  handle: string,
  since: number,
  query: typeof recentQuery.Type = {},
) =>
  rows
    .filter(
      (row) =>
        row.handle === handle &&
        row.createdAt >= since &&
        (query.guid === undefined || row.guid === query.guid) &&
        (query.after === undefined || row.id > query.after) &&
        (query.before === undefined || row.id < query.before) &&
        (query.until === undefined || row.createdAt < query.until),
    )
    .toSorted((a, b) => (query.reverse ? b.id - a.id : a.id - b.id))
    .slice(0, query.limit ?? rows.length);
