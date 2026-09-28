// Text-only composition of AI Elements Prompt Input for the lab's text-only API.
// https://elements.ai-sdk.dev/components/prompt-input
import * as SelectPrimitive from "@radix-ui/react-select";
import type {
  ButtonHTMLAttributes,
  ComponentProps,
  FormHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

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

// Adapted from AI Elements PromptInputSelect; these are the Select primitives it composes.
export const PromptInputSelect = SelectPrimitive.Root;
export const PromptInputSelectValue = SelectPrimitive.Value;

export const PromptInputSelectTrigger = ({
  children,
  className = "",
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger>) => (
  <SelectPrimitive.Trigger className={`ai-select-trigger ${className}`} {...props}>
    {children}
    <SelectPrimitive.Icon asChild>
      <span className="ai-select-chevron" aria-hidden="true" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
);

export const PromptInputSelectContent = ({
  children,
  className = "",
  container,
  ...props
}: ComponentProps<typeof SelectPrimitive.Content> & { container?: HTMLElement | null }) => (
  <SelectPrimitive.Portal {...(container ? { container } : {})}>
    <SelectPrimitive.Content
      position="popper"
      className={`ai-select-content ${className}`}
      {...props}
    >
      <SelectPrimitive.Viewport className="ai-select-viewport">{children}</SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
);

export const PromptInputSelectItem = ({
  children,
  className = "",
  ...props
}: ComponentProps<typeof SelectPrimitive.Item>) => (
  <SelectPrimitive.Item className={`ai-select-item ${className}`} {...props}>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    <SelectPrimitive.ItemIndicator className="ai-select-check" aria-hidden="true">
      ✓
    </SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>
);
