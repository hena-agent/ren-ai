import { normalizeHandle } from "@repo/onboarding";
import { useState } from "react";
import { copy } from "../copy.ts";
import type { OnboardingClient } from "../onboarding-client.ts";
import { Turnstile } from "../turnstile.tsx";

export function Home({ onboarding }: { onboarding: OnboardingClient }) {
  const [input, setInput] = useState("");
  const [consent, setConsent] = useState(false);
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [answer, setAnswer] = useState<keyof typeof copy.answers>();
  const handle = normalizeHandle(input);
  const invalid = input.length > 0 && !handle;

  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !handle || !consent || !token) return;
    setPending(true);
    setAnswer(undefined);
    try {
      setAnswer(
        await onboarding.submit({
          handle,
          locale: "ko",
          privacyNoticeVersion: copy.privacyNoticeVersion,
          turnstileToken: token,
        }),
      );
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
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        <label className="flex flex-col gap-2">
          {copy.form.countryLabel}
          <select defaultValue={copy.market.country}>
            <option value={copy.market.country}>
              {copy.market.country} ({copy.market.dialCode})
            </option>
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
        <a className="w-fit underline underline-offset-4" href="/privacy">
          {copy.home.privacyLink}
        </a>
        <Turnstile onToken={setToken} />
        <button
          className="rounded bg-slate-900 p-3 text-white disabled:opacity-50"
          disabled={pending || !handle || !consent || !token}
          type="submit"
        >
          {copy.form.submit}
        </button>
      </form>
      {pending && <output>{copy.form.inProgress}</output>}
      {answer && <output>{copy.answers[answer]}</output>}
      {showWaitlist && <p>{copy.form.waitlistLink}</p>}
    </main>
  );
}
