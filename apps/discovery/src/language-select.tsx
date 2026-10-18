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
  disabled = false,
  onValueChange,
}: {
  value: Locale;
  id?: string;
  label: string;
  describedBy?: string;
  className?: string;
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
        className={`language-select ${className ?? ""}`}
        id={id}
        aria-label={label}
        aria-describedby={describedBy}
      >
        <Select.Value />
        <Select.Icon aria-hidden="true">⌄</Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="language-select-content" position="popper" sideOffset={4}>
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
