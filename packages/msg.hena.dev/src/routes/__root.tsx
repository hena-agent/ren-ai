import { HeadContent, Outlet, Scripts, createRootRouteWithContext } from "@tanstack/react-router";
import type { OnboardingClient } from "../onboarding-client.ts";
import "../styles.css";

export const Route = createRootRouteWithContext<{ onboarding: OnboardingClient }>()({
  component: Root,
});

function Root() {
  return (
    <html lang="ko">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <HeadContent />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
