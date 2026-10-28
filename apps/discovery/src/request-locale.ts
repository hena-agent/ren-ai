import { isLocale, localePreferenceKey } from "./public-routing.ts";

export function requestLocale(request: Request) {
  const saved = request.headers
    .get("Cookie")
    ?.split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${localePreferenceKey}=`))
    ?.slice(localePreferenceKey.length + 1);
  if (isLocale(saved)) return saved;
  const header = request.headers.get("Accept-Language");
  const languages = (header?.split(",") ?? []).flatMap((entry) => {
    const match =
      /^([a-z]{2,3})(?:-[a-z0-9]+)*(?:\s*;\s*q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?$/.exec(
        entry.trim().toLowerCase(),
      );
    if (!match || !isLocale(match[1])) return [];
    return [{ locale: match[1], quality: Number(match[2] ?? "1") }];
  });
  return (
    languages.filter(({ quality }) => quality > 0).toSorted((a, b) => b.quality - a.quality)[0]
      ?.locale ?? "en"
  );
}
