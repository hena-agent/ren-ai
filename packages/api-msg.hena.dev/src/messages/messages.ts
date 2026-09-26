import type { Effect } from "effect";

/** The adapter must force iMessage and must never fall back to SMS. */
export interface Messages {
  sendText(handle: string, text: string): Effect.Effect<{ readonly guid: string | null }, Error>;
}
