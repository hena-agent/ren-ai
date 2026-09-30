import { OnboardingAnswer, OnboardingRequest, WaitlistRequest } from "@ren-ai/onboarding";
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";

export const onboardingApi = HttpApi.make("onboarding").add(
  HttpApiGroup.make("public")
    .add(
      HttpApiEndpoint.post("submit", "/onboarding", {
        payload: OnboardingRequest,
        success: OnboardingAnswer,
        error: Schema.String.pipe(HttpApiSchema.status(400)),
      }),
    )
    .add(
      HttpApiEndpoint.post("waitlist", "/waitlist", {
        payload: WaitlistRequest,
        success: Schema.Void,
        error: Schema.String.pipe(HttpApiSchema.status(400)),
      }),
    ),
);
