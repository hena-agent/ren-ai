import { Effect, PartitionedSemaphore } from "effect";
import type { Conversation } from "../conversations/conversations.ts";
import type { outbox } from "./outbox.ts";
import type { MessageBubble } from "@ren-ai/plugin-application/protocol";

/** A retried call never continues a stale batch after a partial or uncertain send. */
export const bubbleSender = (sends: Effect.Success<ReturnType<typeof outbox>>) =>
  Effect.gen(function* () {
    const locks = yield* PartitionedSemaphore.make<number>({ permits: 1 });
    return (conversation: Conversation, messages: readonly MessageBubble[], callID: string) =>
      PartitionedSemaphore.withPermit(
        locks,
        conversation.id,
      )(
        Effect.gen(function* () {
          const results: string[] = [];
          for (const [index, bubble] of messages.entries()) {
            const id = index === 0 ? callID : `${callID}:bubble:${index + 1}`;
            const previous = yield* sends.delivery(conversation, id);
            if (previous) {
              const outcomes = yield* Effect.forEach(messages, (_, position) =>
                sends
                  .delivery(
                    conversation,
                    position === 0 ? callID : `${callID}:bubble:${position + 1}`,
                  )
                  .pipe(
                    Effect.map((state) => `Bubble ${position + 1}: ${state ?? "not attempted"}`),
                  ),
              );
              return `not sent: this call was already recorded; no bubbles were sent again. Reconsider unsent bubbles with a new call.\n${outcomes.join("\n")}`;
            }
            const result = yield* sends.send(conversation, bubble.text, id, bubble.delaySeconds);
            if (messages.length === 1) return result;
            results.push(`Bubble ${index + 1}: ${result}`);
            if (result !== "sent") {
              results.push(`Remaining ${messages.length - index - 1} bubbles not attempted.`);
              break;
            }
          }
          return results.join("\n");
        }),
      );
  });
