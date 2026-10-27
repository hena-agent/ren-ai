import { useEffect, useRef, useState } from "react";
import { Schema } from "effect";
import {
  DiscoveryRequest,
  discoveryNotices,
  MobileNumber,
  type DiscoveryNotices,
} from "@ren-ai/onboarding";
import { ContactName, ContactProfile } from "./contact-profile.tsx";
import { Turnstile } from "@ren-ai/onboarding/turnstile";
import type { PublicPersona } from "@ren-ai/onboarding";
import type { DiscoveryClient } from "./client.ts";
import { RegistrationError, loadDiscoveryNotices } from "./client.ts";
import { RegistrationFeedback } from "./registration-feedback.tsx";
import { useCopy, useLocale } from "./locale.tsx";
import type { Locale } from "./locale.tsx";
import { PhoneField } from "./phone-field.tsx";
import { LanguageSelect } from "./language-select.tsx";
import { PrivacyDisclosure } from "./privacy-disclosure.tsx";
import { RelationshipSelect } from "./relationship-select.tsx";
import type { StartingRelationship } from "@ren-ai/onboarding";
import type { ImageStyle } from "./image-style.ts";
import { invitationToken } from "./public-routing.ts";
import { visitContext } from "./activity.ts";

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
  imageStyle,
  client,
  onBack,
  onSuccess,
  onBusyChange,
  onRefresh,
}: {
  liked: readonly PublicPersona[];
  imageStyle: ImageStyle;
  client: DiscoveryClient;
  onBack: () => void;
  onSuccess: (status: "waiting" | "active") => void;
  onBusyChange?: (busy: boolean) => void;
  onRefresh?: () => Promise<void>;
}) {
  const copy = useCopy();
  const { locale } = useLocale();
  const [notices, setNotices] = useState<DiscoveryNotices>(discoveryNotices);
  const discoveryNotice = notices[locale];
  const [conversationLanguage, setConversationLanguage] = useState<Locale>(locale);
  const [startingRelationship, setStartingRelationship] = useState<StartingRelationship>("dating");
  const [contact, setContact] = useState<{
    phone: string | undefined;
    touched: boolean;
    consentLanguage: Locale | null;
  }>({ phone: undefined, touched: false, consentLanguage: null });
  const [token, setToken] = useState<string | null>("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<RegistrationError>();
  const retryBlocked = failure?.retryAt !== undefined;
  useEffect(() => {
    if (failure?.retryAt === undefined) return undefined;
    const timer = setTimeout(
      () => setFailure(new RegistrationError(failure.code, failure.requestId)),
      Math.max(0, failure.retryAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [failure]);
  const reselecting = Boolean(reselection().reselectionToken);
  const [invitation, setInvitation] = useState(() => invitationToken(window.location.hash) ?? "");
  const submitting = useRef(false);
  const handle = isMobileNumber(contact.phone) ? contact.phone : undefined;
  const invalid = contact.touched && !handle;
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setContact((current) => ({ ...current, touched: true }));
    if (
      submitting.current ||
      retryBlocked ||
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
    await perform(async () => {
      const answer = await client.join(
        Schema.decodeUnknownSync(DiscoveryRequest)({
          handle,
          ...visitContext(),
          locale,
          conversationLanguage,
          startingRelationship,
          imageStyle,
          privacyNoticeVersion: discoveryNotice.version,
          likedPersonaIDs: liked.map((persona) => persona.id),
          turnstileToken: token,
          name,
          ...(age && { age: Number(age) }),
          ...(gender && { gender }),
          ...reselection(),
          ...(invitation && { invitationToken: invitation }),
        }),
      );
      const fragment = new URLSearchParams(window.location.hash.slice(1));
      if (invitation) fragment.set("invite", invitation);
      else fragment.delete("invite");
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}${fragment.size ? `#${fragment}` : ""}`,
      );
      onSuccess(answer.status);
    });
  }
  async function perform(action: () => Promise<void>) {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    onBusyChange?.(true);
    setFailure(undefined);
    try {
      await action();
    } catch (cause) {
      setFailure(
        cause instanceof RegistrationError ? cause : new RegistrationError("registration"),
      );
    } finally {
      submitting.current = false;
      setPending(false);
      onBusyChange?.(false);
      setToken("");
    }
  }
  function recover(notice: boolean) {
    return perform(async () => {
      if (notice) {
        setNotices(await loadDiscoveryNotices());
        setContact((current) => ({ ...current, consentLanguage: null }));
      } else {
        await onRefresh?.();
        onBack();
      }
    });
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
      {invitation && <p className="field-hint">{copy.invitationIntro}</p>}
      <ul className="liked-list" aria-label={copy.selected}>
        {liked.map((persona) => (
          <li key={persona.id}>
            {persona.imageUrl && <img src={persona.imageUrl} decoding="async" alt="" />}
            <span>{persona.name}</span>
          </li>
        ))}
      </ul>
      <form onSubmit={(event) => void submit(event)}>
        <ContactName disabled={pending} />
        <div className="contact-fields">
          <label htmlFor="handle">
            <span className="field-requirement" aria-hidden="true">
              *
            </span>{" "}
            {copy.handle}
          </label>
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
        <ContactProfile disabled={pending} />
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
        <div className="contact-fields">
          <label htmlFor="invitation-code">
            {copy.invitationCode} <span className="field-requirement">{copy.profileOptional}</span>
          </label>
          <input
            id="invitation-code"
            name="invitationCode"
            value={invitation}
            onChange={(event) => setInvitation(event.target.value.trim())}
            maxLength={64}
            pattern="[A-Za-z0-9_\-]+"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-describedby="invitation-code-hint"
            disabled={pending}
          />
          <p id="invitation-code-hint" className="field-hint">
            {copy.invitationCodeHint}
          </p>
        </div>
        <p className="ai-notice">{discoveryNotice.aiNotice}</p>
        <PrivacyDisclosure notices={notices} />
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
        {failure && !pending && (
          <RegistrationFeedback
            failure={failure}
            onReview={() => void recover(false)}
            onReload={() => void recover(true)}
          />
        )}
        <button
          className="primary-button join-submit"
          type="submit"
          disabled={
            pending || retryBlocked || contact.consentLanguage !== locale || !token || !liked.length
          }
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
