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
  profiles: (signal: AbortSignal) => Promise<readonly PublicPersona[]>;
  join: (request: DiscoveryRequest) => Promise<DiscoveryAnswer>;
};

export const discoveryClient: DiscoveryClient = {
  profiles: async (signal) => {
    const response = await fetch(path("/discovery/personas"), { signal });
    if (!response.ok) throw new Error("Profiles unavailable");
    return Schema.decodeUnknownSync(Schema.Array(PublicPersona))(await response.json()).map(
      (persona) => ({
        ...persona,
        imageUrl: persona.imageUrl.startsWith("/") ? path(persona.imageUrl) : persona.imageUrl,
        ...(persona.portraits === undefined
          ? {}
          : {
              portraits: {
                anime: persona.portraits.anime.startsWith("/")
                  ? path(persona.portraits.anime)
                  : persona.portraits.anime,
                photo: persona.portraits.photo.startsWith("/")
                  ? path(persona.portraits.photo)
                  : persona.portraits.photo,
              },
            }),
      }),
    );
  },
  join: async (request) => {
    const response = await fetch(path("/discovery/waitlist"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error("Registration unavailable");
    return Schema.decodeUnknownSync(DiscoveryAnswer)(await response.json());
  },
};
