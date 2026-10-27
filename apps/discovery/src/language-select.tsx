import { SelectField } from "./select-field.tsx";
import type { Locale } from "./locale.tsx";

const options: readonly { value: Locale; label: string; language: string }[] = [
  { value: "ko", label: "한국어", language: "ko" },
  { value: "en", label: "English", language: "en" },
  { value: "ja", label: "日本語", language: "ja" },
];
export function LanguageSelect({
  onValueChange,
  ...props
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
    <SelectField
      {...props}
      options={options}
      onValueChange={(next) => {
        const option = options.find((item) => item.value === next)!;
        onValueChange(option.value);
      }}
    />
  );
}
