import type { PublicPersona } from "@ren-ai/onboarding";
import { messages } from "./locale.tsx";
import {
  locales,
  localizedPath,
  personaTitle,
  publicOrigin,
  publicRoute,
  shareUrl,
} from "./public-routing.ts";
import type { Locale } from "./public-routing.ts";
import type { SocialImage } from "./social-image.ts";
import { socialImage } from "./social-image.ts";

const ogLocales = { ko: "ko_KR", en: "en_US", ja: "ja_JP" };

export function pageSeo(
  url: URL,
  persona?: PublicPersona,
  initialLocale?: Locale,
  imageOverride?: SocialImage,
) {
  const route = publicRoute(url);
  const { path, id, style = "anime" } = route;
  const locale = route.locale ?? initialLocale ?? "en";
  const copy = messages[locale];
  const missing = Boolean(id && !persona);
  const title = persona
    ? personaTitle(persona, locale)
    : missing
      ? `${copy.publicProfile.notFound} — RenAI`
      : path === "/"
        ? copy.home.pageTitle
        : `RenAI — ${copy.explore}`;
  const suffix = {
    ko: "RenAI의 가상 AI 페르소나. iMessage로 일상을 나눠요.",
    en: "A fictional AI persona on RenAI. Share everyday moments on iMessage.",
    ja: "RenAIの架空のAIペルソナ。iMessageで日常を分かち合おう。",
  }[locale];
  const introduction =
    persona &&
    Array.from((persona.profile?.introduction ?? persona.bio).replace(/\s+/g, " "))
      .slice(0, 150)
      .join("");
  const description = persona ? `${introduction} — ${suffix}` : copy.home.intro;
  const canonical = `${publicOrigin}${localizedPath(path, locale)}`;
  const image = imageOverride ?? socialImage(persona, style, locale);
  const meta = {
    description,
    robots: missing ? "noindex,follow" : "index,follow,max-image-preview:large",
    "og:type": "website",
    "og:site_name": "RenAI",
    "og:locale": ogLocales[locale],
    "og:title": title,
    "og:description": description,
    "og:url": persona ? shareUrl(persona.id, style, locale) : canonical,
    "og:image": image.url,
    "og:image:secure_url": image.url,
    "og:image:type": image.type,
    "og:image:width": String(image.width),
    "og:image:height": String(image.height),
    "og:image:alt": image.alt,
    "twitter:card": "summary_large_image",
    "twitter:title": title,
    "twitter:description": description,
    "twitter:image": image.url,
    "twitter:image:alt": image.alt,
  };
  return { locale, path, id, style, missing, title, description, canonical, image, meta };
}

export function languageLinks(path: string) {
  return [...locales, "x-default" as const].map((language) => ({
    language,
    href: `${publicOrigin}${localizedPath(path, language === "x-default" ? "en" : language)}`,
  }));
}

export function structuredPage(seo: ReturnType<typeof pageSeo>, persona?: PublicPersona) {
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": seo.canonical,
    url: seo.canonical,
    name: seo.title,
    description: seo.description,
    inLanguage: seo.locale,
    image: seo.image.url,
    isPartOf: {
      "@type": "WebSite",
      "@id": `${publicOrigin}/#website`,
      url: `${publicOrigin}/`,
      name: "RenAI",
    },
    ...(persona && {
      about: {
        "@type": "CreativeWork",
        name: persona.name,
        description: seo.description,
        image: seo.image.url,
        genre: "Fictional AI persona",
      },
    }),
  };
}

export function alternateLocales(locale: Locale) {
  return locales.filter((language) => language !== locale).map((language) => ogLocales[language]);
}
