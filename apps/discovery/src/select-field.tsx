import * as Select from "@radix-ui/react-select";

export function SelectField({
  value,
  id,
  label,
  describedBy,
  className,
  iconOnly = false,
  disabled = false,
  options,
  portalContainer,
  onValueChange,
}: {
  value: string;
  id?: string;
  label: string;
  describedBy?: string;
  className?: string;
  iconOnly?: boolean;
  disabled?: boolean;
  options: readonly { value: string; label: string; language?: string }[];
  portalContainer?: HTMLElement | null | undefined;
  onValueChange: (value: string) => void;
}) {
  return (
    <Select.Root value={value} onValueChange={onValueChange} disabled={disabled}>
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
      <Select.Portal container={portalContainer}>
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
