import { Schema } from "effect";
import { DiscoveryAnswer, PublicPersona } from "@ren-ai/onboarding";
import type { DiscoveryRequest } from "@ren-ai/onboarding";

declare global {
  interface ImportMetaEnv {
    readonly VITE_DISCOVERY_API_URL?: string;
  }
}
function path(route: string) {
  return (import.meta.env.VITE_DISCOVERY_API_URL ?? "").replace(/\/$/, "") + route;
}

export type DiscoveryClient = {
  profiles: (signal: AbortSignal, reselectionToken?: string) => Promise<readonly PublicPersona[]>;
  join: (request: DiscoveryRequest) => Promise<DiscoveryAnswer>;
};
export class ReselectionError extends Error {}

export const discoveryClient: DiscoveryClient = {
  profiles: async (signal, reselectionToken) => {
    const response = await (reselectionToken === undefined
      ? fetch(path("/discovery/personas"), { signal })
      : fetch(path("/discovery/reselection/personas"), {
          method: "POST",
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
          body: JSON.stringify({ reselectionToken }),
          signal,
          cache: "no-store",
        }));
    if (!response.ok) throw new Error("Profiles unavailable");
    return Schema.decodeUnknownSync(Schema.Array(PublicPersona))(await response.json());
  },
  join: async (request) => {
    const response = await fetch(path("/discovery/waitlist"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      const reselection = await response.text();
      if (reselection.trim() === '"reselection"')
        throw new ReselectionError("Reselection link unavailable");
      throw new Error("Registration unavailable");
    }
    return Schema.decodeUnknownSync(DiscoveryAnswer)(await response.json());
  },
};
