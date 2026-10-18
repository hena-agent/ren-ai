import { Effect } from "effect";
import type { Notifications } from "../messages/messages.ts";
import { observe } from "../diagnostics.ts";

/** Correlate the HTTP operation with native submission; never echo payload-bearing errors. */
const request = <A extends object>(
  operation: string,
  body: (requestId: string) => Effect.Effect<A, Error>,
) =>
  Effect.suspend(() => {
    const requestId = crypto.randomUUID();
    return observe(operation, body(requestId), () => ({}), requestId).pipe(
      Effect.map((value) => ({ ...value, requestId })),
      Effect.mapError(() => `Notification operation failed (request ${requestId})`),
    );
  });

export const notificationHandlers = (notifications: Notifications) => ({
  notify: ({ handle, text }: { handle: string; text: string }) =>
    request("notification.send", (requestId) => notifications.sendText(handle, text, requestId)),
  notificationStatus: ({ guid }: { guid: string }) =>
    request("notification.status", () => notifications.status(guid)),
});
