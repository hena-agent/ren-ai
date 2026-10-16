import { useRef, useState } from "react";
import { Schema } from "effect";
import { discoveryNotices, MobileNumber } from "@ren-ai/onboarding";
import { Turnstile } from "@ren-ai/onboarding/turnstile";
import type { PublicPersona } from "@ren-ai/onboarding";
import type { DiscoveryClient } from "./client.ts";
import { useCopy, useLocale } from "./locale.tsx";
import type { Locale } from "./locale.tsx";
import { PhoneField } from "./phone-field.tsx";

const isMobileNumber = Schema.is(MobileNumber);

function siteKey() {
  return import.meta.env.VITE_TURNSTILE_SITE_KEY || "1x00000000000000000000BB";
}
declare global {
  interface ImportMetaEnv {
    readonly VITE_TURNSTILE_SITE_KEY?: string;
  }
}

export function JoinForm({
  liked,
  client,
  onBack,
  onSuccess,
  onBusyChange,
}: {
  liked: readonly PublicPersona[];
  client: DiscoveryClient;
  onBack: () => void;
  onSuccess: (status: "waiting" | "active") => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const copy = useCopy();
  const { locale } = useLocale();
  const discoveryNotice = discoveryNotices[locale];
  const [conversationLanguage, setConversationLanguage] = useState<Locale>(locale);
  const [contact, setContact] = useState<{
    phone: string | undefined;
    checked: boolean;
    consentLanguage: Locale | null;
  }>({ phone: undefined, checked: false, consentLanguage: null });
  const [token, setToken] = useState<string | null>("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState(false);
  const submitting = useRef(false);
  const handle = isMobileNumber(contact.phone) ? contact.phone : undefined;
  const invalid = contact.checked && contact.phone !== undefined && !handle;
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setContact((current) => ({ ...current, checked: true }));
    if (
      submitting.current ||
      !handle ||
      contact.consentLanguage !== locale ||
      !token ||
      !liked.length
    )
      return;
    submitting.current = true;
    setPending(true);
    onBusyChange?.(true);
    setFailure(false);
    try {
      const answer = await client.join({
        handle,
        locale,
        conversationLanguage,
        privacyNoticeVersion: discoveryNotice.version,
        likedPersonaIDs: liked.map((persona) => persona.id),
        turnstileToken: token,
      });
      onSuccess(answer.status);
    } catch {
      setFailure(true);
    } finally {
      submitting.current = false;
      setPending(false);
      onBusyChange?.(false);
      setToken("");
    }
  }
  return (
    <section className="join-panel" aria-labelledby="join-title">
      <button className="text-button back-button" type="button" onClick={onBack} disabled={pending}>
        <span className="icon icon-arrow" aria-hidden="true" />
        {copy.back}
      </button>
      <p className="form-step">{copy.joinStep}</p>
      <h1 id="join-title">{copy.joinTitle}</h1>
      <p className="join-intro">{copy.joinIntro}</p>
      <ul className="liked-list" aria-label={copy.selected}>
        {liked.map((persona) => (
          <li key={persona.id}>
            <img src={persona.imageUrl} alt="" />
            <span>{persona.name}</span>
          </li>
        ))}
      </ul>
      <form onSubmit={(event) => void submit(event)}>
        <div className="contact-fields">
          <label htmlFor="handle">{copy.handle}</label>
          <PhoneField
            value={contact.phone}
            onChange={(phone) => setContact((current) => ({ ...current, phone, checked: false }))}
            onBlur={() => setContact((current) => ({ ...current, checked: true }))}
            invalid={invalid}
            disabled={pending}
          />
          <p className="field-hint" id="handle-hint">
            {copy.handleHint}
          </p>
          {invalid && (
            <p id="handle-error" role="alert">
              {copy.invalidHandle}
            </p>
          )}
        </div>
        <label htmlFor="conversation-language">{copy.conversationLanguage}</label>
        <select
          id="conversation-language"
          value={conversationLanguage}
          disabled={pending}
          aria-describedby="conversation-language-hint"
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value === "ko" || value === "en" || value === "ja") setConversationLanguage(value);
          }}
        >
          <option value="ko">한국어</option>
          <option value="en">English</option>
          <option value="ja">日本語</option>
        </select>
        <p id="conversation-language-hint" className="field-hint">
          {copy.conversationLanguageHint}
        </p>
        <p className="ai-notice">{discoveryNotice.aiNotice}</p>
        <details className="privacy-disclosure">
          <summary>{copy.privacy}</summary>
          <h3>{discoveryNotice.title}</h3>
          <p className="notice-version">{discoveryNotice.version}</p>
          {discoveryNotice.sections.map((section) => (
            <section key={section.title}>
              <h4>{section.title}</h4>
              {section.paragraphs.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </section>
          ))}
        </details>
        <label className="consent">
          <input
            type="checkbox"
            checked={contact.consentLanguage === locale}
            onChange={(event) =>
              setContact({ ...contact, consentLanguage: event.target.checked ? locale : null })
            }
            disabled={pending}
          />
          <span>{discoveryNotice.consent}</span>
        </label>
        {!pending && <Turnstile onToken={setToken} siteKey={siteKey()} language={locale} />}
        {token === null && (
          <p className="form-error" role="alert">
            {copy.verificationFailure}
          </p>
        )}
        {failure && (
          <p className="form-error" role="alert">
            {copy.joinFailure}
          </p>
        )}
        <button
          className="primary-button join-submit"
          type="submit"
          disabled={
            pending || !handle || contact.consentLanguage !== locale || !token || !liked.length
          }
        >
          {pending ? copy.pending : copy.submit}
        </button>
        {pending && <output className="sr-only">{copy.pending}</output>}
      </form>
    </section>
  );
}
