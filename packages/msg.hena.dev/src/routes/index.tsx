import { createFileRoute } from "@tanstack/react-router";
import { Home } from "../pages/home.tsx";

export const Route = createFileRoute("/")({ component: HomePage });

function HomePage() {
  return <Home onboarding={Route.useRouteContext().onboarding} />;
}
