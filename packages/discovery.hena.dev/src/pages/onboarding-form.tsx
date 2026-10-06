import { countries, normalizeHandle, normalizeWaitlistEmail } from "@ren-ai/onboarding";
import type { Country } from "@ren-ai/onboarding";
import { useState } from "react";
import { copy } from "../copy.ts";
import type { OnboardingClient } from "../onboarding-client.ts";
import { Turnstile } from "../turnstile.tsx";

const isCountry = (value: string): value is Country => Object.hasOwn(countries, value);

export function OnboardingForm({
  onboarding,
  personaID,
  onUnavailable,
}: {
  onboarding: OnboardingClient;
  personaID?: string;
  onUnavailable: () => void;
}) {
  const [input, setInput] = useState("");
  const [country, setCountry] = useState<Country>("KR");
  const [consent, setConsent] = useState(false);
  const [token, setToken] = useState<string | null>("");
  const [pending, setPending] = useState(false);
  const [answer, setAnswer] = useState<keyof typeof copy.answers>();
  const handle = normalizeHandle(input, country);
  const invalid = input.length > 0 && !handle;

  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (copy.privacyNoticeVersion === "pending" || pending || !handle || !consent || !token) return;
    setPending(true);
    setAnswer(undefined);
    try {
      const result = await onboarding.submit({
        ...(personaID === undefined ? {} : { personaID }),
        handle,
        locale: "ko",
        privacyNoticeVersion: copy.privacyNoticeVersion,
        turnstileToken: token,
      });
      setAnswer(result);
      if (result === "persona_unavailable") onUnavailable();
    } catch {
      setAnswer("try_later");
    } finally {
      setPending(false);
      setToken("");
    }
  }

  const showWaitlist = answer === "no_imessage" || answer === "unknown" || answer === "full";

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 px-6 py-12 text-slate-900">
      <h1 className="text-4xl font-bold tracking-tight">{copy.home.title}</h1>
      <p className="text-lg leading-relaxed">{copy.home.description}</p>
      {copy.privacyNoticeVersion !== "pending" ? (
        <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
          <label className="flex flex-col gap-2">
            {copy.form.countryLabel}
            <select
              value={country}
              onChange={(event) => {
                if (isCountry(event.target.value)) setCountry(event.target.value);
              }}
            >
              {Object.entries(countries).map(([code, rule]) => (
                <option key={code} value={code}>
                  {code} (+{rule.dialCode})
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-2">
            {copy.form.handleLabel}
            <input
              className="rounded border p-2"
              autoComplete="username"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              aria-invalid={invalid}
              aria-describedby={invalid ? "handle-error" : undefined}
            />
          </label>
          {invalid && (
            <p id="handle-error" role="alert">
              {copy.form.invalidHandle}
            </p>
          )}
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            />
            {copy.form.consent}
          </label>
          <div>
            <a className="block w-fit underline underline-offset-4" href="/privacy">
              {copy.home.privacyLink}
            </a>
            {!pending && <Turnstile onToken={setToken} />}
          </div>
          {token === null && <p role="alert">{copy.form.verificationFailed}</p>}
          <button
            className="rounded bg-slate-900 p-3 text-white disabled:opacity-50"
            disabled={pending || !handle || !consent || !token}
            type="submit"
          >
            {copy.form.submit}
          </button>
        </form>
      ) : (
        <p>{copy.privacy.placeholder}</p>
      )}
      {pending && <output>{copy.form.inProgress}</output>}
      {answer && <output>{copy.answers[answer]}</output>}
      {showWaitlist && <Waitlist onboarding={onboarding} answer={answer} />}
    </main>
  );
}

function Waitlist({
  onboarding,
  answer,
}: {
  onboarding: OnboardingClient;
  answer: "no_imessage" | "unknown" | "full";
}) {
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<"success" | "failure">();
  const email = normalizeWaitlistEmail(input);
  const invalid = input.length > 0 && !email;

  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !email) return;
    setPending(true);
    setResult(undefined);
    try {
      await onboarding.joinWaitlist({ email, locale: "ko", answer });
      setResult("success");
    } catch {
      setResult("failure");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-2xl font-semibold">{copy.waitlist.title}</h2>
      <p>{copy.form.waitlistLink}</p>
      {result !== "success" && (
        <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
          <label className="flex flex-col gap-2">
            {copy.waitlist.emailLabel}
            <input
              className="rounded border p-2"
              type="email"
              autoComplete="email"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              aria-invalid={invalid}
              aria-describedby={invalid ? "waitlist-email-error" : undefined}
            />
          </label>
          {invalid && (
            <p id="waitlist-email-error" role="alert">
              {copy.waitlist.invalidEmail}
            </p>
          )}
          <button
            className="rounded bg-slate-900 p-3 text-white disabled:opacity-50"
            disabled={pending || !email}
            type="submit"
          >
            {copy.waitlist.submit}
          </button>
        </form>
      )}
      {result && <output>{copy.waitlist[result]}</output>}
    </section>
  );
}
