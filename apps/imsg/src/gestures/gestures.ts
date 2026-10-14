import type { Effect } from "effect";

export interface Gestures {
  /** Verify Apple Events and Accessibility without opening a User's Conversation. */
  probe(): Effect.Effect<void, Error>;
  /** false means a new message interrupted typing; nothing should be sent. */
  typing(handle: string, text: string, durationMillis: number): Effect.Effect<boolean, Error>;
  read(handle: string): Effect.Effect<void, Error>;
  react(handle: string, tapback: string): Effect.Effect<void, Error>;
}
