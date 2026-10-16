import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import ko from "./copy.json";
import en from "./copy.en.json";
import ja from "./copy.ja.json";

export type Locale = "ko" | "en" | "ja";
const messages = { ko, en, ja } satisfies Record<Locale, typeof ko>;
const key = "renai.locale";
const supported = (value: string | null | undefined): value is Locale =>
  value === "ko" || value === "en" || value === "ja";

function readLocale(): Locale {
  try {
    const saved = localStorage.getItem(key);
    if (supported(saved)) return saved;
  } catch {
    // Browser language still works when storage is unavailable.
  }
  return navigator.languages.map((language) => language.split("-")[0]).find(supported) ?? "en";
}

const LocaleContext = createContext<{
  locale: Locale;
  choose: (locale: Locale) => void;
  storageFailure: boolean;
}>({ locale: "ko", choose: () => {}, storageFailure: false });
export const useLocale = () => useContext(LocaleContext);
export const useCopy = () => messages[useLocale().locale];

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState(readLocale);
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
        <select
          aria-label={copy.languageSetting}
          value={locale}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (supported(value)) choose(value);
          }}
        >
          <option value="ko" lang="ko">
            한국어
          </option>
          <option value="en" lang="en">
            English
          </option>
          <option value="ja" lang="ja">
            日本語
          </option>
        </select>
      </label>
      {storageFailure && <output className="storage-warning">{copy.languageStorageFailure}</output>}
    </div>
  );
}
