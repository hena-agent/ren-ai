import { useRef, useState } from "react";
import { Schema } from "effect";
import { DiscoveryRequest, discoveryNotices, MobileNumber } from "@ren-ai/onboarding";
import { OptionalProfile } from "./optional-profile.tsx";
import { Turnstile } from "@ren-ai/onboarding/turnstile";
import type { PublicPersona } from "@ren-ai/onboarding";
import type { DiscoveryClient } from "./client.ts";
import { ReselectionError } from "./client.ts";
import { useCopy, useLocale } from "./locale.tsx";
import type { Locale } from "./locale.tsx";
import { PhoneField } from "./phone-field.tsx";
import { LanguageSelect } from "./language-select.tsx";
import { PrivacyDisclosure } from "./privacy-disclosure.tsx";
import { RelationshipSelect } from "./relationship-select.tsx";
import type { StartingRelationship } from "@ren-ai/onboarding";

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
  const [startingRelationship, setStartingRelationship] = useState<StartingRelationship>("dating");
  const [contact, setContact] = useState<{
    phone: string | undefined;
    touched: boolean;
    consentLanguage: Locale | null;
  }>({ phone: undefined, touched: false, consentLanguage: null });
  const [token, setToken] = useState<string | null>("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<false | "registration" | "reselection">(false);
  const reselecting = Boolean(reselection().reselectionToken);
  const submitting = useRef(false);
  const handle = isMobileNumber(contact.phone) ? contact.phone : undefined;
  const invalid = contact.touched && !handle;
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setContact((current) => ({ ...current, touched: true }));
    if (
      submitting.current ||
      !handle ||
      contact.consentLanguage !== locale ||
      !token ||
      !liked.length ||
      !event.currentTarget.checkValidity()
    )
      return;
    const {
      name: rawName,
      age,
      gender,
    } = Schema.decodeUnknownSync(
      Schema.Struct({ name: Schema.String, age: Schema.String, gender: Schema.String }),
    )(Object.fromEntries(new FormData(event.currentTarget)));
    const name = rawName.trim();
    submitting.current = true;
    setPending(true);
    onBusyChange?.(true);
    setFailure(false);
    try {
      const answer = await client.join(
        Schema.decodeUnknownSync(DiscoveryRequest)({
          handle,
          locale,
          conversationLanguage,
          startingRelationship,
          privacyNoticeVersion: discoveryNotice.version,
          likedPersonaIDs: liked.map((persona) => persona.id),
          turnstileToken: token,
          ...(name && { name }),
          ...(age && { age: Number(age) }),
          ...(gender && { gender }),
          ...reselection(),
        }),
      );
      onSuccess(answer.status);
    } catch (cause) {
      setFailure(cause instanceof ReselectionError ? "reselection" : "registration");
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
      <h1 id="join-title">{reselecting ? copy.reselectionTitle : copy.joinTitle}</h1>
      <p className="join-intro">{reselecting ? copy.reselectionIntro : copy.joinIntro}</p>
      <ul className="liked-list" aria-label={copy.selected}>
        {liked.map((persona) => (
          <li key={persona.id}>
            {persona.imageUrl && <img src={persona.imageUrl} alt="" />}
            <span>{persona.name}</span>
          </li>
        ))}
      </ul>
      <form onSubmit={(event) => void submit(event)}>
        <div className="contact-fields">
          <label htmlFor="handle">{copy.handle}</label>
          <PhoneField
            id="handle"
            describedBy={invalid ? "handle-error" : "handle-hint"}
            value={contact.phone}
            onChange={(phone) => setContact((current) => ({ ...current, phone, touched: false }))}
            onBlur={() =>
              setContact((current) => ({ ...current, touched: current.phone !== undefined }))
            }
            invalid={invalid}
            disabled={pending}
          />
          <div className="field-note">
            <p className={invalid ? "field-hint replaced" : "field-hint"} id="handle-hint">
              {copy.handleHint}
            </p>
            {invalid && (
              <p id="handle-error" role="alert">
                {copy.invalidHandle}
              </p>
            )}
          </div>
        </div>
        <OptionalProfile disabled={pending} />
        <RelationshipSelect
          value={startingRelationship}
          onChange={setStartingRelationship}
          disabled={pending}
        />
        <div className="contact-fields conversation-language-field">
          <label htmlFor="conversation-language">{copy.conversationLanguage}</label>
          <LanguageSelect
            value={conversationLanguage}
            id="conversation-language"
            label={copy.conversationLanguage}
            className="form-language-select"
            disabled={pending}
            describedBy="conversation-language-hint"
            onValueChange={setConversationLanguage}
          />
          <p id="conversation-language-hint" className="field-hint">
            {copy.conversationLanguageHint}
          </p>
        </div>
        <p className="ai-notice">{discoveryNotice.aiNotice}</p>
        <PrivacyDisclosure />
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
            {failure === "reselection" ? copy.reselectionFailure : copy.joinFailure}
          </p>
        )}
        <button
          className="primary-button join-submit"
          type="submit"
          disabled={pending || contact.consentLanguage !== locale || !token || !liked.length}
        >
          {pending ? copy.pending : copy.submit}
        </button>
        {pending && <output className="sr-only">{copy.pending}</output>}
      </form>
    </section>
  );
}

function reselection() {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("reselect");
  return token ? { reselectionToken: token } : {};
}
