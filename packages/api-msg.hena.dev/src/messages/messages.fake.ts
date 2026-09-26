import { Effect } from "effect";
import type { Messages } from "./messages.ts";

export const fakeMessages = (events: string[] = []) => {
  const bubbles: { handle: string; text: string }[] = [];
  const messages: Messages = {
    sendText: (handle, text) =>
      Effect.sync(() => {
        events.push("send");
        bubbles.push({ handle, text });
        return { guid: `fake-${bubbles.length}` };
      }),
  };
  return { messages, bubbles, events };
};
