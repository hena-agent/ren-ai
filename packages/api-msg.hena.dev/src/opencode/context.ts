import { Message } from "@opencode/ai";
import type { SessionContext } from "@opencode/plugin/effect/session";

const readingGuide =
  "Read the English tags as events on your phone. Times are in your time zone. <conversation-started> begins this Conversation; <notice> is the service's Notice; <message> is his text; <photo> has an attached image; <tapback> is his reaction; <edited> and <unsent> change an earlier message; <gap> is elapsed time; <checked-phone> is a wake after quiet; <sent-by-you> is a message from your handle. <phone> gives the current time and the status of your last message: read HH:MM, delivered (not read or receipts off), or sent (not delivered).";

const restart =
  "The server restarted while you were working. Continue from where you left off without repeating completed work.";

const isOpenCodeNotice = (message: Message) =>
  (message.role === "user" || message.role === "system") &&
  message.content.length === 1 &&
  message.content[0]!.type === "text" &&
  ((message.role === "user" && message.content[0]!.text === restart) ||
    /^Today's date is now: [^\n]+$/.test(message.content[0]!.text));

export const cleanContext = (
  event: Pick<SessionContext, "system" | "messages" | "tools">,
  prompt: string,
  lastLine: string,
  allowed: ReadonlySet<string>,
) => {
  event.system.splice(0, event.system.length, { type: "text", text: `${prompt}\n${readingGuide}` });
  event.messages.splice(
    0,
    event.messages.length,
    ...event.messages.filter((message) => !isOpenCodeNotice(message)),
    Message.user(lastLine),
  );
  const removed: string[] = [];
  for (const name of Object.keys(event.tools)) {
    if (allowed.has(name)) continue;
    delete event.tools[name];
    removed.push(name);
  }
  return removed;
};
