import { OnboardingAnswer, OnboardingRequest } from "@repo/onboarding";
import { Schema } from "effect";

export type OnboardingClient = {
  submit: (
    request: Schema.Schema.Type<typeof OnboardingRequest>,
  ) => Promise<Schema.Schema.Type<typeof OnboardingAnswer>>;
};

export const onboardingClient: OnboardingClient = {
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
};
