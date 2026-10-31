import { publicRoute, localizedPath, localePreferenceCookie } from "./public-routing.ts";
import { requestLocale } from "./request-locale.ts";

/** Shared by the Worker and Vite so local navigation follows the public URL contract. */
export function pageRedirect(request: Request) {
  const url = new URL(request.url);
  const trimmed = new URL(url);
  trimmed.pathname = url.pathname.replace(/\/$/, "") || "/";
  const page = publicRoute(trimmed);
  if (!["/", "/about", "/explore"].includes(page.path) && !page.id) return undefined;
  const locale = page.locale ?? requestLocale(request);
  const target = localizedPath(page.path === "/" ? "/explore" : page.path, locale);
  if (url.pathname === target) return undefined;
  url.pathname = target;
  return new Response(null, {
    status: page.path === "/" || !page.locale ? 307 : 308,
    headers: {
      Location: url.href,
      "Cache-Control": "no-store",
      ...(!page.locale && { Vary: "Accept-Language, Cookie" }),
      ...(page.locale === "en" && { "Set-Cookie": localePreferenceCookie("en") }),
    },
  });
}
