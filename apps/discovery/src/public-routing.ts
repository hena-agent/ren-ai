import { Schema } from "effect";
import { BrowsePage, DiscoveryLocale, PublicPersona } from "@ren-ai/onboarding";
import type { ImageStyle } from "./image-style.ts";

export const publicOrigin = "https://renai.im";
export const previewVersion = "v2";
export const invitationToken = (hash: string) => new URLSearchParams(hash.slice(1)).get("invite");
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
  return `${publicOrigin}${personaPath(id)}?style=${style}&preview=${previewVersion}`;
}

export function previewRoute(url: URL) {
  const match = /^(\/personas\/[^/]+)\/og\/(anime|photo)\/[^/]+$/.exec(url.pathname);
  if (!match) return undefined;
  const { id } = publicRoute(new URL(match[1]!, url));
  if (!id) return undefined;
  const style: ImageStyle = match[2] === "photo" ? "photo" : "anime";
  return { id, style };
}

/** Where the explorer's server-sampled first page continues: its language and next cursor. */
const SampledPage = Schema.Struct({
  locale: DiscoveryLocale,
  nextCursor: BrowsePage.fields.nextCursor,
});
export type SampledPage = typeof SampledPage.Type;
const PublicBootstrap = Schema.Struct({
  people: Schema.Array(PublicPersona),
  page: Schema.optionalKey(SampledPage),
});

export function readPublicBootstrap(text: string | null) {
  return text === null ? undefined : Schema.decodeUnknownSync(PublicBootstrap)(JSON.parse(text));
}
