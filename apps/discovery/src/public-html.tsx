import { renderToStaticMarkup, renderToString } from "react-dom/server";
import type { PublicPersona } from "@ren-ai/onboarding";
import { withImageStyle } from "./image-style.ts";
import { LocaleProvider } from "./locale.tsx";
import { App } from "./app.tsx";
import { Home } from "./home.tsx";
import {
  publicOrigin,
  personaPath,
  personaTitle,
  shareUrl,
  publicRoute,
} from "./public-routing.ts";
import type { SocialImage } from "./social-image.ts";
import copy from "./copy.json";

export function publicResponse(
  template: string,
  people: readonly PublicPersona[],
  url: URL,
  image: SocialImage,
) {
  const { id, style = "anime" } = publicRoute(url);
  const persona = people.find((person) => person.id === id);
  const missing = Boolean(id && !persona);
  const home = url.pathname === "/";
  const title = persona
    ? personaTitle(persona)
    : missing
      ? `${copy.publicProfile.notFound} — Ren AI`
      : home
        ? copy.home.pageTitle
        : `Ren AI — ${copy.explore}`;
  const description = persona
    ? `${Array.from((persona.profile?.introduction ?? persona.bio).replace(/\s+/g, " "))
        .slice(0, 150)
        .join("")} — Ren AI의 가상 AI 페르소나. iMessage로 일상을 나눠요.`
    : copy.home.intro;
  const canonical = `${publicOrigin}${id ? personaPath(id) : url.pathname}`;
  const structured = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": canonical,
    url: canonical,
    name: title,
    description,
    image: image.url,
    isPartOf: {
      "@type": "WebSite",
      "@id": `${publicOrigin}/#website`,
      url: `${publicOrigin}/`,
      name: "Ren AI",
    },
    ...(persona && {
      about: {
        "@type": "CreativeWork",
        name: persona.name,
        description,
        image: image.url,
        genre: "Fictional AI persona",
      },
    }),
  };
  const head = renderToStaticMarkup(
    <>
      <title>{title}</title>
      <meta name="description" content={description} />
      <meta
        name="robots"
        content={missing ? "noindex,follow" : "index,follow,max-image-preview:large"}
      />
      <link rel="canonical" href={canonical} />
      <meta property="og:type" content="website" />
      <meta property="og:site_name" content="Ren AI" />
      <meta property="og:locale" content="ko_KR" />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={persona ? shareUrl(persona.id, style) : canonical} />
      <meta property="og:image" content={image.url} />
      {image.url.startsWith("https:") && (
        <meta property="og:image:secure_url" content={image.url} />
      )}
      <meta property="og:image:type" content={image.type} />
      <meta property="og:image:width" content={String(image.width)} />
      <meta property="og:image:height" content={String(image.height)} />
      <meta property="og:image:alt" content={image.alt} />
      <meta
        name="twitter:card"
        content={image.width >= image.height ? "summary_large_image" : "summary"}
      />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={image.url} />
      <meta name="twitter:image:alt" content={image.alt} />
    </>,
  );
  const markup = renderToString(
    home ? (
      <LocaleProvider initialLocale="ko">
        <Home />
      </LocaleProvider>
    ) : (
      <App initialPeople={people} personaId={id} initialStyle={style} initialLocale="ko" />
    ),
  );
  // The bootstrap contains only schema-validated public fields, never a private Catalog snapshot.
  const bootstrap = JSON.stringify(people).replace(/</g, "\\u003c");
  const jsonLd = JSON.stringify(structured).replace(/</g, "\\u003c");
  const html = template
    .replace(/<title>[\s\S]*?<\/title>/, "")
    .replace(/<meta\s+name="description"[\s\S]*?\/>/, "")
    .replace("</head>", () => `${head}<script type="application/ld+json">${jsonLd}</script></head>`)
    .replace(
      '<div id="root"></div>',
      () =>
        `<div id="root">${markup}</div>${home ? "" : `<script id="public-personas" type="application/json">${bootstrap}</script>`}`,
    );
  return new Response(html, {
    status: missing ? 404 : 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...(missing && { "X-Robots-Tag": "noindex" }),
    },
  });
}

export function sitemap(people: readonly PublicPersona[]) {
  const entries = people.map((persona) => {
    const image = withImageStyle(persona, "anime").imageUrl;
    return `<url><loc>${publicOrigin}${personaPath(persona.id)}</loc>${image ? `<image:image><image:loc>${escapeXml(new URL(image, "https://api.renai.im").href)}</image:loc></image:image>` : ""}</url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"><url><loc>${publicOrigin}/</loc></url><url><loc>${publicOrigin}/explore</loc></url>${entries.join("")}</urlset>`;
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
