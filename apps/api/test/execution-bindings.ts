import type { CloudflareBindings } from "../src/cloudflare-config.ts";

export const readyApplicationHealth = {
  service: "api-app",
  revision: "development",
  status: "ready",
  database: "ready",
  storage: "durable-object-sqlite",
  bootstrapOnly: true,
  executor: { service: "api-msg", revision: "development", status: "ready" },
  applicationRuntime: { revision: "development", status: "ready" },
};

export const executionBindings: CloudflareBindings = {
  PERSONA_CATALOG_URL: "https://admin.example",
  TOKEN_CATALOG: "catalog-secret",
  TURNSTILE_SECRET: "turnstile-secret",
  TOKEN_MANAGEMENT: "management-secret",
  API_MSG_URL: "https://api-msg.example",
  BOOTSTRAP_ONLY: "false",
};
