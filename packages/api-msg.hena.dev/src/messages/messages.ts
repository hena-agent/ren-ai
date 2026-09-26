import type { Effect } from "effect";

/** The adapter must force iMessage and must never fall back to SMS. */
export interface Messages {
  sendText(handle: string, text: string): Effect.Effect<{ readonly guid: string | null }, Error>;
  /** The latest outcome of a Notice attempted at or after since, even when imsg returned no GUID. */
  textStatus(
    handle: string,
    since: number,
  ): Effect.Effect<"sent" | "no_imessage" | "unknown", Error>;
}
