import { Schema } from "effect";
import { BrowsePage, DiscoveryLocale, PublicPersona } from "@ren-ai/onboarding";
import type { ImageStyle } from "./image-style.ts";

export const publicOrigin = "https://renai.im";
export const locales = ["ko", "en", "ja"] as const;
export type Locale = (typeof locales)[number];
export const localePreferenceKey = "renai.locale";
export const localePreferenceCookie = (locale: Locale) =>
  `${localePreferenceKey}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax`;
export const isLocale = (value: string | null | undefined): value is Locale =>
  locales.some((locale) => locale === value);
export function languageRoute(pathname: string) {
  const first = pathname.split("/")[1];
  const locale = isLocale(first) ? first : undefined;
  return { locale, path: locale ? pathname.slice(locale.length + 1) || "/" : pathname };
}
export function localizedPath(path: string, locale: Locale) {
  const route = languageRoute(path);
  if (locale === "en") return route.path;
  return `/${locale}${route.path === "/" ? "" : route.path}`;
}
export const previewVersion = "v3";
export const invitationToken = (hash: string) => new URLSearchParams(hash.slice(1)).get("invite");
export const personaPath = (id: string) => `/personas/${encodeURIComponent(id)}`;
export const personaTitle = (persona: PublicPersona, locale: Locale = "en") =>
  `${persona.name} — ${{ ko: "RenAI의 AI 페르소나", en: "An AI persona on RenAI", ja: "RenAIのAIペルソナ" }[locale]}`;

export function publicRoute(url: URL) {
  const language = languageRoute(url.pathname);
  const match = /^\/personas\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})$/.exec(language.path);
  const style = url.searchParams.get("style");
  const selectedStyle: ImageStyle | undefined =
    style === "anime" || style === "photo" ? style : undefined;
  return {
    ...language,
    id: match?.[1],
    style: selectedStyle,
  };
}

export function shareUrl(id: string, style: ImageStyle, locale: Locale = "en") {
  return `${publicOrigin}${localizedPath(personaPath(id), locale)}?style=${style}&preview=${previewVersion}`;
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
