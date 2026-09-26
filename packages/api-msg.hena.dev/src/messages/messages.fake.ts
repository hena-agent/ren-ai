import { Effect } from "effect";
import type { Messages } from "./messages.ts";

export const fakeMessages = (events: string[] = []) => {
  const bubbles: { handle: string; text: string }[] = [];
  const statuses = new Map<string, "sent" | "no_imessage" | "unknown">();
  const rejected = new Set<string>();
  const statusFailures = new Set<string>();
  const statusChecks: string[] = [];
  const messages: Messages = {
    sendText: (handle, text) =>
      Effect.suspend(() =>
        rejected.has(handle)
          ? Effect.fail(new Error("imsg send timed out"))
          : Effect.sync(() => {
              events.push("send");
              bubbles.push({ handle, text });
              return { guid: `fake-${bubbles.length}` };
            }),
      ),
    textStatus: (handle) =>
      Effect.suspend(() => {
        statusChecks.push(handle);
        return statusFailures.has(handle)
          ? Effect.fail(new Error("Messages status temporarily unavailable"))
          : Effect.sync(
              () =>
                statuses.get(handle) ??
                (bubbles.some((bubble) => bubble.handle === handle) ? "sent" : "unknown"),
            );
      }),
  };
  return { messages, bubbles, events, statuses, rejected, statusFailures, statusChecks };
};
