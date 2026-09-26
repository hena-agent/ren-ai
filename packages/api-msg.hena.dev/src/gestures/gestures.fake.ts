import { Effect } from "effect";
import type { Gestures } from "./gestures.ts";

export const fakeGestures = (events: string[] = []) => {
  const typing: { handle: string; durationMillis: number }[] = [];
  let interrupted = false;
  const gestures: Gestures = {
    typing: (handle, durationMillis) =>
      Effect.sync(() => {
        events.push("typing");
        typing.push({ handle, durationMillis });
        return !interrupted;
      }),
    read: () => Effect.void,
    react: () => Effect.void,
  };
  return { gestures, typing, events, interrupt: () => (interrupted = true) };
};
