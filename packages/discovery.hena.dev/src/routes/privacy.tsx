import { createFileRoute } from "@tanstack/react-router";
import { Privacy } from "../pages/privacy.tsx";

export const Route = createFileRoute("/privacy")({ component: Privacy });
