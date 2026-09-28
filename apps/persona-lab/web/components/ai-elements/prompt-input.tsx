// Text-only composition of AI Elements Prompt Input for the lab's text-only API.
// https://elements.ai-sdk.dev/components/prompt-input
import type { ButtonHTMLAttributes, FormHTMLAttributes, TextareaHTMLAttributes } from "react";

export const PromptInput = (props: FormHTMLAttributes<HTMLFormElement>) => <form {...props} />;

export const PromptInputTextarea = ({
  onKeyDown,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea
    rows={2}
    onKeyDown={(event) => {
      onKeyDown?.(event);
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.nativeEvent.isComposing &&
        !event.defaultPrevented
      ) {
        event.preventDefault();
        event.currentTarget.form?.requestSubmit();
      }
    }}
    {...props}
  />
);

export const PromptInputSubmit = (props: ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button type="submit" {...props} />
);
