import { Effect } from "effect";
import type { Gestures } from "./gestures.ts";

export const fakeGestures = (events: string[] = []) => {
  const typing: { handle: string; durationMillis: number }[] = [];
  const reads: string[] = [];
  const reactions: { handle: string; tapback: string }[] = [];
  let interrupted = false;
  const gestures: Gestures = {
    typing: (handle, _text, durationMillis) =>
      Effect.sync(() => {
        events.push("typing");
        typing.push({ handle, durationMillis });
        return !interrupted;
      }),
    read: (handle) =>
      Effect.sync(() => {
        reads.push(handle);
      }),
    react: (handle, tapback) =>
      Effect.sync(() => {
        reactions.push({ handle, tapback });
      }),
  };
  return { gestures, typing, reads, reactions, events, interrupt: () => (interrupted = true) };
};
