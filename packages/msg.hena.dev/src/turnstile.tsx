import { Turnstile as Verification } from "@ren-ai/onboarding/turnstile";
import { turnstileSiteKey } from "./config.ts";

export function Turnstile({ onToken }: { onToken: (token: string | null) => void }) {
  return <Verification onToken={onToken} siteKey={turnstileSiteKey} />;
}
