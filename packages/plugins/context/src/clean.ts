import { Message } from "@opencode/ai";
import type { SessionContext } from "@opencode/plugin/effect/session";

const restart =
  "The server restarted while you were working. Continue from where you left off without repeating completed work.";
const sourceStart =
  /(?=^(?:Instructions from:|New instructions apply from:|The instructions (?:from |changed:)|Skills provide specialized|The available skills|New skills are available|The following skill IDs|Skill guidance is no longer|# Code Mode|# Your Model|When you create a worktree outside|The Code Mode tool catalog|Code Mode tools are no longer|No Code Mode tools|Today's date|Here is some useful information|The environment you are running in is now:))/m;
const unwanted =
  /^(?:Today's date(?::| is now:) [A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{4}\s*$|Here is some useful information about the environment you are running in:\n<env>|The environment you are running in is now:\n<env>|# Code Mode\n\nUse the `execute` tool|# Your Model|When you create a worktree outside|The Code Mode tool catalog|Code Mode tools are no longer|No Code Mode tools|Skills provide specialized|The available skills|New skills are available|The following skill IDs|Skill guidance is no longer)/;

// OpenCode 2.0.19 joins instruction sources with two newlines, including in history updates.
// Keep the agent's own system part intact; never reconstruct it from catalog metadata.
const cleanInstructions = (text: string) =>
  text
    .split(sourceStart)
    .filter((part) => !unwanted.test(part))
    .join("")
    .trim();

const cleanMessage = (message: Message): Message | undefined => {
  if (
    (message.role !== "user" && message.role !== "system") ||
    message.content.length !== 1 ||
    message.content[0]!.type !== "text"
  )
    return message;
  const text = message.content[0]!.text;
  if (message.role === "user") {
    return text === restart || /^Today's date is now: [^\n]+$/.test(text) ? undefined : message;
  }
  const cleaned = cleanInstructions(text);
  if (!cleaned) return undefined;
  if (cleaned === text) return message;
  return Message.make({
    id: message.id,
    role: message.role,
    content: [Message.text(cleaned)],
    metadata: message.metadata,
    providerMetadata: message.providerMetadata,
    native: message.native,
  });
};

export const cleanContext = (
  event: Pick<SessionContext, "system" | "messages" | "tools">,
  lastLine: string,
  allowed: ReadonlySet<string>,
) => {
  event.system.splice(
    0,
    event.system.length,
    ...event.system.flatMap((part, index) => {
      if (index === 0) return [part];
      const text = cleanInstructions(part.text);
      return text ? [{ ...part, text }] : [];
    }),
  );
  event.messages.splice(
    0,
    event.messages.length,
    ...event.messages.flatMap((message) => {
      const cleaned = cleanMessage(message);
      return cleaned ? [cleaned] : [];
    }),
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
