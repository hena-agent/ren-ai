import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import ko from "./copy.json";
import en from "./copy.en.json";
import ja from "./copy.ja.json";
import { LanguageSelect } from "./language-select.tsx";

export type Locale = "ko" | "en" | "ja";
const messages = { ko, en, ja } satisfies Record<Locale, typeof ko>;
const key = "renai.locale";
const supported = (value: string | null | undefined): value is Locale =>
  value === "ko" || value === "en" || value === "ja";

/** The first supported language in preference order, as browsers report or request them. */
export function preferredLocale(languages: readonly string[]): Locale {
  return languages.map((language) => language.toLowerCase().split("-")[0]).find(supported) ?? "en";
}

function readLocale(): Locale {
  try {
    const saved = localStorage.getItem(key);
    if (supported(saved)) return saved;
  } catch {
    // Browser language still works when storage is unavailable.
  }
  return preferredLocale(navigator.languages);
}

const LocaleContext = createContext<{
  locale: Locale;
  choose: (locale: Locale) => void;
  storageFailure: boolean;
}>({ locale: "ko", choose: () => {}, storageFailure: false });
export const useLocale = () => useContext(LocaleContext);
export const useCopy = () => messages[useLocale().locale];

export function LocaleProvider({
  children,
  initialLocale,
}: {
  children: ReactNode;
  initialLocale?: Locale | undefined;
}) {
  const [locale, setLocale] = useState(initialLocale ?? readLocale);
  const [storageFailure, setStorageFailure] = useState(false);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const choose = (next: Locale) => {
    setLocale(next);
    try {
      localStorage.setItem(key, next);
      setStorageFailure(false);
    } catch {
      setStorageFailure(true);
    }
  };
  return <LocaleContext value={{ locale, choose, storageFailure }}>{children}</LocaleContext>;
}

export function LocalePicker() {
  const { locale, choose, storageFailure } = useLocale();
  const copy = useCopy();
  return (
    <div className="locale-picker">
      <label>
        <span className="sr-only">{copy.languageSetting}</span>
        <LanguageSelect
          value={locale}
          label={copy.languageSetting}
          iconOnly
          onValueChange={choose}
        />
      </label>
      {storageFailure && <output className="storage-warning">{copy.languageStorageFailure}</output>}
    </div>
  );
}
