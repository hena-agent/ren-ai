import type { PublicPersona } from "@ren-ai/onboarding";
import { useCopy, useLocale } from "./locale.tsx";

export function ProfileLanguages({
  persona,
  compact = false,
}: {
  persona: PublicPersona;
  compact?: boolean;
}) {
  const copy = useCopy();
  const { locale } = useLocale();
  const languages = persona.languages;
  if (!languages || !Object.keys(languages.proficiency).length) return null;
  const names = new Intl.DisplayNames(locale, { type: "language" });
  const entries = Object.entries(languages.proficiency);
  return (
    <section className="profile-languages" aria-label={copy.languages}>
      {!compact && <h3>{copy.languages}</h3>}
      <ul>
        {(compact ? entries.slice(0, 2) : entries).map(([code, level]) => (
          <li key={code}>
            <strong>{names.of(code)}</strong>
            <span className="profile-language-level">
              {languages.native?.includes(code) ? copy.native : copy[level]}
              {!compact && languages.primary === code && ` · ${copy.primary}`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
