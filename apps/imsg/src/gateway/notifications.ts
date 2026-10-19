import type { Notifications } from "../messages/messages.ts";
import { messageRequest } from "./operation.ts";

export const notificationHandlers = (notifications: Notifications) => ({
  notify: ({ handle, text }: { handle: string; text: string }) =>
    messageRequest("notification.send", (requestId) =>
      notifications.sendText(handle, text, requestId),
    ),
  notificationStatus: ({ guid }: { guid: string }) =>
    messageRequest("notification.status", () => notifications.status(guid)),
});
