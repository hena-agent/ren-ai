import { useMemo, useState } from "react";
import type { FocusEventHandler } from "react";
import PhoneInput from "react-phone-number-input/mobile";
import type { Country } from "react-phone-number-input/mobile";
import type { Labels } from "react-phone-number-input";
import {
  getCountries,
  getCountryCallingCode,
  getExampleNumber,
  isSupportedCountry,
} from "libphonenumber-js/mobile";
import examples from "libphonenumber-js/mobile/examples";
import { useCopy, useLocale } from "./locale.tsx";

declare global {
  namespace Intl {
    interface Locale {
      /** Absent before Safari 17, Chrome 130 and Firefox 153. */
      getTimeZones?(): string[];
    }
  }
}

const countries = getCountries();
/** Two regional indicator symbols, which platforms render as the country's flag. */
const flag = (country: Country) =>
  String.fromCodePoint(0x1f1a5 + country.charCodeAt(0), 0x1f1a5 + country.charCodeAt(1));
const code = (country: Country) => `+${getCountryCallingCode(country)}`;

/** Where the device's time zone is, then the region of a browser language, then Korea. */
function detectCountry(): Country {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    countries.find((country) =>
      new Intl.Locale(`und-${country}`).getTimeZones?.().includes(zone),
    ) ??
    navigator.languages
      .map((language) => new Intl.Locale(language).maximize().region)
      .filter((region) => region !== undefined)
      .find((region) => isSupportedCountry(region)) ??
    "KR"
  );
}

type Order = (Country | "|" | "...")[];

/** The picker opens the platform's own list while showing only the flag and calling code. */
function CountryPicker({
  value,
  options,
  onChange,
  onFocus,
  onBlur,
  disabled,
  "aria-label": label,
}: {
  value: Country;
  options: readonly ({ value: Country; label: string } | { divider: true })[];
  onChange: (country: Country) => void;
  onFocus: FocusEventHandler<HTMLSelectElement>;
  onBlur: FocusEventHandler<HTMLSelectElement>;
  disabled?: boolean;
  "aria-label": string;
}) {
  return (
    <span className="country-picker">
      <span aria-hidden="true">{`${flag(value)} ${code(value)}`}</span>
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onFocus={onFocus}
        onBlur={onBlur}
        onChange={(event) => {
          const next = event.currentTarget.value;
          if (isSupportedCountry(next)) onChange(next);
        }}
      >
        {options.map((option) =>
          "divider" in option ? (
            <option key="divider" disabled>
              ──────────
            </option>
          ) : (
            <option key={option.value} value={option.value}>
              {`${flag(option.value)} ${option.label} ${code(option.value)}`}
            </option>
          ),
        )}
      </select>
    </span>
  );
}

/** A mobile number typed for a chosen country; `onChange` receives it in international form. */
export function PhoneField({
  id,
  describedBy,
  value,
  onChange,
  onBlur,
  invalid,
  disabled,
}: {
  id: string;
  describedBy: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  onBlur: () => void;
  invalid: boolean;
  disabled: boolean;
}) {
  const copy = useCopy();
  const { locale } = useLocale();
  const [detected] = useState(detectCountry);
  const [country, setCountry] = useState<Country | undefined>(detected);
  const order = useMemo(
    (): Order => [...new Set<Country>([detected, "KR", "JP", "US"]), "|", "..."],
    [detected],
  );
  const labels = useMemo(() => {
    const names = new Intl.DisplayNames([locale], { type: "region" });
    const named: Labels = { country: copy.countryCode };
    for (const each of countries) named[each] = names.of(each)!;
    return named;
  }, [locale, copy.countryCode]);
  return (
    <PhoneInput
      id={id}
      className="phone-field"
      defaultCountry={detected}
      countryOptionsOrder={order}
      addInternationalOption={false}
      labels={labels}
      locales={locale}
      countrySelectComponent={CountryPicker}
      onCountryChange={setCountry}
      placeholder={country && getExampleNumber(country, examples)!.formatNational()}
      value={value ?? ""}
      onChange={onChange}
      onBlur={onBlur}
      aria-invalid={invalid}
      aria-describedby={describedBy}
      disabled={disabled}
    />
  );
}
