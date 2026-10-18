import { Effect } from "effect";
import { fakeMessages } from "./messages.fake.ts";
import type { Notifications } from "./messages.ts";

export const fakeNotifications = (): Notifications => {
  const { messages } = fakeMessages();
  return {
    sendText: (handle, text) =>
      messages.sendText(handle, text).pipe(Effect.map(({ guid }) => ({ guid: guid! }))),
    status: (guid) => messages.status(guid),
    probe: () => Effect.void,
  };
};
