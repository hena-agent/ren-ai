// Adapted from AI Elements Message: https://elements.ai-sdk.dev/components/message
import type { HTMLAttributes } from "react";
import type { UIMessage } from "ai";

type MessageProps = HTMLAttributes<HTMLDivElement> & { from: UIMessage["role"] };

export const Message = ({ className = "", from, ...props }: MessageProps) => (
  <div
    className={`message ${from === "user" ? "message-user" : "message-reply"} ${className}`}
    {...props}
  />
);

export const MessageContent = ({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={`message-content ${className}`} {...props} />
);
