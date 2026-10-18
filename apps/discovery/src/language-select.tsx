import * as Select from "@radix-ui/react-select";
import type { Locale } from "./locale.tsx";

const options: readonly { value: Locale; label: string; language: string }[] = [
  { value: "ko", label: "한국어", language: "ko" },
  { value: "en", label: "English", language: "en" },
  { value: "ja", label: "日本語", language: "ja" },
];
export function LanguageSelect({
  value,
  id,
  label,
  describedBy,
  className,
  iconOnly = false,
  disabled = false,
  onValueChange,
}: {
  value: Locale;
  id?: string;
  label: string;
  describedBy?: string;
  className?: string;
  iconOnly?: boolean;
  disabled?: boolean;
  onValueChange: (value: Locale) => void;
}) {
  return (
    <Select.Root
      value={value}
      onValueChange={(next) => {
        const option = options.find((item) => item.value === next)!;
        onValueChange(option.value);
      }}
      disabled={disabled}
    >
      <Select.Trigger
        className={`language-select ${iconOnly ? "header-language-select" : ""} ${className ?? ""}`}
        id={id}
        aria-label={label}
        aria-describedby={describedBy}
        title={iconOnly ? label : undefined}
      >
        <span className={iconOnly ? "sr-only" : undefined}>
          <Select.Value />
        </span>
        <Select.Icon className="language-select-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
            {iconOnly ? (
              <>
                <circle cx="12" cy="12" r="9" />
                <ellipse cx="12" cy="12" rx="4" ry="9" />
                <path d="M3 12h18" />
              </>
            ) : (
              <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            )}
          </svg>
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          className="language-select-content"
          position="popper"
          align="end"
          sideOffset={6}
        >
          <Select.Viewport>
            {options.map((option) => (
              <Select.Item
                className="language-select-item"
                key={option.value}
                value={option.value}
                lang={option.language}
              >
                <Select.ItemText>{option.label}</Select.ItemText>
                <Select.ItemIndicator className="language-select-indicator" aria-hidden="true">
                  ✓
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
