import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen.ts";
import { onboardingClient } from "./onboarding-client.ts";
import type { OnboardingClient } from "./onboarding-client.ts";

export function getRouter(onboarding: OnboardingClient = onboardingClient) {
  return createRouter({ routeTree, context: { onboarding } });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
