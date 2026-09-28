import { createFileRoute } from "@tanstack/react-router";
import { Home } from "../pages/home.tsx";

// Stryker disable next-line StringLiteral -- generated route tree supplies the path at runtime
export const Route = createFileRoute("/")({ component: HomePage });

function HomePage() {
  return <Home onboarding={Route.useRouteContext().onboarding} />;
}
