// Adapted from AI Elements Conversation: https://elements.ai-sdk.dev/components/conversation
import { useEffect } from "react";
import type { ComponentProps } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

export const Conversation = ({
  className = "",
  ...props
}: ComponentProps<typeof StickToBottom>) => (
  <StickToBottom
    className={`conversation ${className}`}
    initial="instant"
    resize="instant"
    role="log"
    aria-live="polite"
    {...props}
  />
);

export const ConversationContent = ({
  className = "",
  scrollClassName = "",
  ...props
}: ComponentProps<typeof StickToBottom.Content>) => (
  <StickToBottom.Content
    className={`conversation-content ${className}`}
    scrollClassName={`conversation-scroll ${scrollClassName}`}
    {...props}
  />
);

export const ConversationScrollButton = () => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return (
    <button
      className="scroll-bottom"
      type="button"
      onClick={() => {
        void scrollToBottom();
      }}
      aria-label="최신 대화로 이동"
    >
      최신 대화 ↓
    </button>
  );
};

export const ConversationInitialScroll = () => {
  const { scrollToBottom } = useStickToBottomContext();
  useEffect(() => {
    void scrollToBottom("instant");
  }, [scrollToBottom]);
  return null;
};
