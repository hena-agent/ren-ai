import type { ClipboardEvent } from "react";
import type { Character } from "../src/loop.ts";
import {
  Conversation,
  ConversationContent,
  ConversationInitialScroll,
  ConversationScrollButton,
} from "./components/ai-elements/conversation.tsx";
import { Message, MessageContent } from "./components/ai-elements/message.tsx";
import { timeFormatter } from "./labels.ts";

const onCopy = (event: ClipboardEvent<HTMLDivElement>) => {
  const selection = window.getSelection();
  if (
    !selection?.rangeCount ||
    selection.isCollapsed ||
    !event.currentTarget.contains(selection.anchorNode)
  )
    return;
  const range = selection.getRangeAt(0);
  const messages = [...event.currentTarget.querySelectorAll<HTMLElement>(".message")].filter(
    (box) => range.intersectsNode(box),
  );
  if (!messages.length) return;
  event.clipboardData.setData(
    "text/plain",
    messages
      .map(
        (box) =>
          `${box.dataset["speaker"]}:\n[${box.dataset["time"]}] ${box.querySelector(".message-text")?.textContent ?? ""}`,
      )
      .join("\n\n"),
  );
  event.preventDefault();
};

export const Timeline = ({ current }: { current: Character }) => {
  const times = new Map<string, number>();
  for (const entry of current.entries)
    if (entry.type === "input" && entry.at !== undefined) times.set(entry.event.id, entry.at);
  for (const decision of current.decisions)
    if (decision.replyId) times.set(decision.replyId, decision.at);

  return (
    <div className="timeline" onCopy={onCopy}>
      <Conversation key={current.session.id}>
        <ConversationContent>
          {current.session.events.length === 0 && (
            <p className="empty-state">아직 대화가 없습니다.</p>
          )}
          {current.session.events.flatMap((event) => {
            const speaker =
              event.kind === "reply"
                ? current.session.definition.name
                : event.kind === "life"
                  ? "생활 사건"
                  : "사용자";
            const lines =
              event.kind === "reply" ? event.text.split("\n").filter(Boolean) : [event.text];
            return lines.map((text, index) => (
              <Message
                key={`${event.id}-${index}`}
                from={event.kind === "reply" ? "assistant" : "user"}
                className={`${event.kind === "life" ? "message-life" : ""} ${index > 0 ? "message-continuation" : ""}`}
                data-speaker={speaker}
                data-time={
                  times.has(event.id)
                    ? timeFormatter.format(new Date(times.get(event.id)!))
                    : "시간 미상"
                }
              >
                <span className="message-label">{index === 0 ? speaker : ""}</span>
                <MessageContent>
                  <span className="message-text">{text}</span>
                </MessageContent>
              </Message>
            ));
          })}
        </ConversationContent>
        <ConversationInitialScroll />
        <ConversationScrollButton />
      </Conversation>
    </div>
  );
};
