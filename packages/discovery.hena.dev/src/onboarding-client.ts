import {
  OnboardingAnswer,
  OnboardingRequest,
  WaitlistRequest,
  PublicPersonas,
} from "@ren-ai/onboarding";
import { Schema } from "effect";

export type OnboardingClient = {
  catalog: () => Promise<typeof PublicPersonas.Type | undefined>;
  submit: (
    request: Schema.Schema.Type<typeof OnboardingRequest>,
  ) => Promise<Schema.Schema.Type<typeof OnboardingAnswer>>;
  joinWaitlist: (request: Schema.Schema.Type<typeof WaitlistRequest>) => Promise<void>;
};

export const onboardingClient: OnboardingClient = {
  async catalog() {
    const response = await fetch("https://api-msg.hena.dev/personas", {
      signal: AbortSignal.timeout(12_000),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error("Catalog request failed");
    return Schema.decodeUnknownSync(PublicPersonas)(await response.json());
  },
  async submit(request) {
    const response = await fetch("https://api-msg.hena.dev/onboarding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error("Onboarding request failed");
    return Schema.decodeUnknownSync(OnboardingAnswer)(await response.json());
  },
  async joinWaitlist(request) {
    const response = await fetch("https://api-msg.hena.dev/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error("Waitlist request failed");
  },
};
