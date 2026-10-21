import { Schema } from "effect";
import { PublicPersona } from "@ren-ai/onboarding";
import type { ImageStyle } from "./image-style.ts";

export const publicOrigin = "https://renai.im";
export const personaPath = (id: string) => `/personas/${encodeURIComponent(id)}`;
export const personaTitle = (persona: PublicPersona) => `${persona.name} — Ren AI의 AI 페르소나`;

export function publicRoute(url: URL) {
  const match = /^\/personas\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})$/.exec(url.pathname);
  const style = url.searchParams.get("style");
  const selectedStyle: ImageStyle | undefined =
    style === "anime" || style === "photo" ? style : undefined;
  return {
    id: match?.[1],
    style: selectedStyle,
  };
}

export function shareUrl(id: string, style: ImageStyle) {
  return `${publicOrigin}${personaPath(id)}?style=${style}`;
}

export function readPublicPeople(text: string | null) {
  return text === null
    ? undefined
    : Schema.decodeUnknownSync(Schema.Array(PublicPersona))(JSON.parse(text));
}
