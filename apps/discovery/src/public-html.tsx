import { renderToStaticMarkup, renderToString } from "react-dom/server";
import type { PublicPersona, PersonaLink } from "@ren-ai/onboarding";
import { LocaleProvider } from "./locale.tsx";
import { App } from "./app.tsx";
import { About } from "./about.tsx";
import {
  publicOrigin,
  personaPath,
  publicRoute,
  locales,
  localizedPath,
} from "./public-routing.ts";
import type { SampledPage } from "./public-routing.ts";
import { pageSeo, languageLinks, structuredPage, alternateLocales } from "./seo.ts";

/** The application's first HTML, followed by any public people the browser continues from. */
function applicationRoot(url: URL, people: readonly PublicPersona[], page?: SampledPage) {
  const route = publicRoute(url);
  const locale = route.locale ?? page?.locale ?? "en";
  const rendered = Boolean(route.id || page);
  const markup = renderToString(
    route.path === "/about" ? (
      <LocaleProvider initialLocale={locale}>
        <About />
      </LocaleProvider>
    ) : (
      <App
        initialPeople={rendered ? people : undefined}
        initialPage={page}
        personaId={route.id}
        initialStyle={route.style}
        initialLocale={locale}
      />
    ),
  );
  const bootstrap = JSON.stringify({ people, ...(page && { page }) }).replace(/</g, "\\u003c");
  return `<div id="root">${markup}</div>${rendered ? `<script id="public-personas" type="application/json">${bootstrap}</script>` : ""}`;
}

export function publicResponse(
  template: string,
  people: readonly PublicPersona[],
  url: URL,
  page?: SampledPage,
) {
  const route = publicRoute(url);
  const persona = people.find((person) => person.id === route.id);
  const seo = pageSeo(url, persona, page?.locale);
  const { locale, path, missing, title, canonical, meta } = seo;
  const head = renderToStaticMarkup(
    <>
      <title>{title}</title>
      {Object.entries(meta).map(([key, content]) => (
        <meta
          key={key}
          {...(key.startsWith("og:") ? { property: key } : { name: key })}
          content={content}
        />
      ))}
      <link rel="canonical" href={canonical} />
      {!missing &&
        languageLinks(path).map(({ language, href }) => (
          <link key={language} rel="alternate" hrefLang={language} href={href} />
        ))}
      {alternateLocales(locale).map((alternate) => (
        <meta key={alternate} property="og:locale:alternate" content={alternate} />
      ))}
    </>,
  );
  const jsonLd = JSON.stringify(structuredPage(seo, persona)).replace(/</g, "\\u003c");
  const html = template
    .replace('<html lang="ko">', `<html lang="${locale}">`)
    .replace(/<title>[\s\S]*?<\/title>/, "")
    .replace(/<meta\s+name="description"[\s\S]*?\/>/, "")
    .replace("</head>", () => `${head}<script type="application/ld+json">${jsonLd}</script></head>`)
    .replace('<div id="root"></div>', () => applicationRoot(url, people, page));
  return new Response(html, {
    status: missing ? 404 : 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Language": locale,
      ...(missing && { "X-Robots-Tag": "noindex" }),
    },
  });
}

export function sitemap(people: readonly (typeof PersonaLink.Type)[]) {
  const pages = [
    { path: "/about", image: undefined },
    { path: "/explore", image: undefined },
    ...people.map((persona) => ({ path: personaPath(persona.id), image: persona.imageUrl })),
  ];
  const entries = pages.flatMap(({ path, image }) =>
    locales.map((locale) => {
      const alternates = languageLinks(path)
        .map(
          ({ language, href }) =>
            `<xhtml:link rel="alternate" hreflang="${language}" href="${escapeXml(href)}"/>`,
        )
        .join("");
      return `<url><loc>${publicOrigin}${localizedPath(path, locale)}</loc>${alternates}${image ? `<image:image><image:loc>${escapeXml(new URL(image, "https://api.renai.im").href)}</image:loc></image:image>` : ""}</url>`;
    }),
  );
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:xhtml="http://www.w3.org/1999/xhtml">${entries.join("")}</urlset>`;
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
