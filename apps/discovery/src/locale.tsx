import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import ko from "./copy.json";
import en from "./copy.en.json";
import ja from "./copy.ja.json";
import { LanguageSelect } from "./language-select.tsx";
import {
  isLocale,
  languageRoute,
  localizedPath,
  localePreferenceKey,
  localePreferenceCookie,
} from "./public-routing.ts";
import type { Locale } from "./public-routing.ts";

export type { Locale } from "./public-routing.ts";
export const messages = { ko, en, ja } satisfies Record<Locale, typeof ko>;

/** The first supported language in browser preference order. */
function preferredLocale(languages: readonly string[]): Locale {
  return languages.map((language) => language.toLowerCase().split("-")[0]).find(isLocale) ?? "en";
}

function readLocale(): Locale {
  const route = languageRoute(window.location.pathname);
  if (route.locale) return route.locale;
  try {
    const saved = localStorage.getItem(localePreferenceKey);
    if (isLocale(saved)) return saved;
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
    const url = new URL(window.location.href);
    url.pathname = localizedPath(url.pathname, next);
    window.history.replaceState(window.history.state, "", url);
    setLocale(next);
    try {
      document.cookie = localePreferenceCookie(next);
      localStorage.setItem(localePreferenceKey, next);
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
