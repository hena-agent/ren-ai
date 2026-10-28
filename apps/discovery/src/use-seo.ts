import { useEffect } from "react";
import type { PublicPersona } from "@ren-ai/onboarding";
import type { ImageStyle } from "./image-style.ts";
import { useLocale } from "./locale.tsx";
import { localizedPath, personaPath } from "./public-routing.ts";
import { pageSeo, languageLinks, structuredPage, alternateLocales } from "./seo.ts";

export function useSeo(path?: string, persona?: PublicPersona, style: ImageStyle = "anime") {
  const { locale } = useLocale();
  useEffect(() => {
    const url = new URL(window.location.href);
    url.pathname = localizedPath(
      persona ? personaPath(persona.id) : (path ?? url.pathname),
      locale,
    );
    url.searchParams.set("style", style);
    const seo = pageSeo(url, persona);
    document.title = seo.title;
    for (const [key, content] of Object.entries(seo.meta)) {
      const attribute = key.startsWith("og:") ? "property" : "name";
      const node =
        document.head.querySelector(`meta[${attribute}="${key}"]`) ??
        document.createElement("meta");
      node.setAttribute(attribute, key);
      node.setAttribute("content", content);
      document.head.append(node);
    }
    document.head
      .querySelectorAll(
        'link[rel="canonical"], link[hreflang], meta[property="og:locale:alternate"]',
      )
      .forEach((node) => node.remove());
    const canonical = document.createElement("link");
    canonical.rel = "canonical";
    canonical.href = seo.canonical;
    document.head.append(canonical);
    if (!seo.missing)
      for (const { language, href } of languageLinks(seo.path)) {
        const node = document.createElement("link");
        node.rel = "alternate";
        node.hreflang = language;
        node.href = href;
        document.head.append(node);
      }
    for (const alternate of alternateLocales(locale)) {
      const node = document.createElement("meta");
      node.setAttribute("property", "og:locale:alternate");
      node.content = alternate;
      document.head.append(node);
    }
    const structured =
      document.head.querySelector('script[type="application/ld+json"]') ??
      document.createElement("script");
    structured.setAttribute("type", "application/ld+json");
    structured.textContent = JSON.stringify(structuredPage(seo, persona)).replace(/</g, "\\u003c");
    document.head.append(structured);
  }, [locale, path, persona, style]);
}
