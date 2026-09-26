import type { Effect } from "effect";

/** The adapter must force iMessage and must never fall back to SMS. */
export interface Messages {
  sendText(handle: string, text: string): Effect.Effect<{ readonly guid: string | null }, Error>;
  /** Rows are ordered by Messages ROWID; following replays rows after the cursor before watching. */
  after(rowID: number): Effect.Effect<ReadonlyArray<IncomingMessage>, Error>;
  /** All rows in this Handle's chat since the timestamp, including empty (unsent) texts. */
  recent(handle: string, since: number): Effect.Effect<ReadonlyArray<IncomingMessage>, Error>;
  follow(
    rowID: number,
    receive: (row: IncomingMessage) => Effect.Effect<void, Error>,
  ): Effect.Effect<() => void, Error>;
}

export interface IncomingMessage {
  readonly id: number;
  readonly guid: string;
  readonly handle: string;
  readonly createdAt: number;
  readonly text: string;
  readonly fromMe: boolean;
}
