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
const imagePath = (imageUrl: string) => (imageUrl.startsWith("/") ? path(imageUrl) : imageUrl);
const resolvePair = (pair: NonNullable<PublicPersona["portraits"]>) => ({
  ...(pair.anime && { anime: imagePath(pair.anime) }),
  ...(pair.photo && { photo: imagePath(pair.photo) }),
});

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
        imageUrl: imagePath(persona.imageUrl),
        ...(persona.secondaryPortraits === undefined
          ? {}
          : {
              secondaryPortraits: persona.secondaryPortraits.map((image) => ({
                ...image,
                imageUrl: imagePath(image.imageUrl),
              })),
            }),
        ...(persona.portraitGallery === undefined
          ? {}
          : {
              portraitGallery: persona.portraitGallery.map((pair) => ({
                anime: imagePath(pair.anime),
                photo: imagePath(pair.photo),
              })),
            }),
        ...(persona.portraits === undefined
          ? {}
          : {
              portraits: resolvePair(persona.portraits),
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
