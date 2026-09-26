import { createFileRoute } from "@tanstack/react-router";
import { Privacy } from "../pages/privacy.tsx";

// Stryker disable next-line StringLiteral -- generated route tree supplies the path at runtime
export const Route = createFileRoute("/privacy")({ component: Privacy });
