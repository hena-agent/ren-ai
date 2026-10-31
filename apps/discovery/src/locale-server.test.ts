// @vitest-environment node
import { expect, test } from "vitest";
import { fixture, photoPreview } from "../test/server.ts";

test.each(["ko", "en", "ja"] as const)(
  "%s URLs render localized HTML and reciprocal language metadata before JavaScript",
  async (locale) => {
    const f = await fixture();
    for (const path of ["/about", "/explore", "/personas/jia"]) {
      const canonicalPath = locale === "en" ? path || "/" : `/${locale}${path}`;
      const response = await f.send(`${canonicalPath}?style=photo`);
      const html = await response.text();
      expect(response.headers.get("content-language")).toBe(locale);
      expect(html).toContain(`<html lang="${locale}">`);
      expect(html).toContain(`rel="canonical" href="https://renai.im${canonicalPath}"`);
      for (const language of ["ko", "en", "ja", "x-default"])
        expect(html).toContain(
          `hrefLang="${language}" href="https://renai.im${language === "x-default" || language === "en" ? path || "/" : `/${language}${path}`}"`,
        );
      expect(html.match(/property="og:locale:alternate"/g)).toHaveLength(2);
      expect(html).toContain(`"inLanguage":"${locale}"`);
      expect(html).toContain(
        `property="og:locale" content="${{ ko: "ko_KR", en: "en_US", ja: "ja_JP" }[locale]}"`,
      );
      expect(html).toContain(
        `content="${path.startsWith("/personas") ? photoPreview : `https://renai.im/social-${locale}-v3.png`}"`,
      );
    }
    const profilePath = `${locale === "en" ? "" : `/${locale}`}/personas/jia`;
    expect(await (await f.send(profilePath)).text()).toContain("햇살 좋은 날엔 같이 걸어요.");
    const xml = await (await f.send("/sitemap.xml")).text();
    expect(xml).toContain(`<loc>https://renai.im${profilePath}</loc>`);
    expect(xml).toContain(`hreflang="${locale}" href="https://renai.im${profilePath}"`);
    expect(xml).not.toContain("https://renai.im/en");
  },
);

test("language redirects preserve queries and invalid localized routes stay unindexed", async () => {
  const f = await fixture();
  for (const [from, to] of [
    ["/en/about", "/about"],
    ["/en/explore", "/explore"],
    ["/explore/", "/explore"],
    ["/en/personas/jia", "/personas/jia"],
    ["/personas/jia/", "/personas/jia"],
    ["/en/about/", "/about"],
  ] as const) {
    const response = await f.send(`${from}?style=photo&utm_source=friend`);
    expect(response.status).toBe(from.startsWith("/en") ? 308 : 307);
    expect(response.headers.get("location")).toBe(
      `https://renai.im${to}?style=photo&utm_source=friend`,
    );
  }
  expect((await f.send("/ja/invalid")).status).toBe(404);
  expect(f.fetcher).not.toHaveBeenCalled();
  f.fetcher.mockResolvedValueOnce(Response.json([]));
  const missing = await (await f.send("/personas/withdrawn")).text();
  expect(missing).toContain("This profile isn&#x27;t public.");
  expect(missing).not.toContain('rel="alternate"');
  f.fetcher.mockRejectedValueOnce(new Error("private"));
  const failed = await f.send("/ja/personas/jia");
  expect(failed.status).toBe(503);
  expect(await failed.text()).toContain('<html lang="ja">');
});

test.each([
  ["ko-KR,ko;q=0.9,en;q=0.8", "ko"],
  ["ja-JP,en;q=0.8", "ja"],
  ["fr-FR,ko;q=0.5,ja;q=0.9", "ja"],
  ["ja;q=0,ko;q=0.8", "ko"],
  ["fr-FR,*;q=0.5", "en"],
  ["ko;q=bad,ja;q=2,en;q=0.5", "en"],
  ["KO-kr;q=0.8,ja;q=0.8", "ko"],
  ["ko;q=0", "en"],
])(
  "unprefixed pages negotiate %s as %s without overriding explicit URLs",
  async (header, locale) => {
    const f = await fixture();
    for (const path of ["/about", "/explore", "/personas/jia"]) {
      const response = await f.send(path, "HEAD", { "Accept-Language": header });
      expect(response.status).toBe(locale === "en" ? 200 : 307);
      expect(response.headers.get("vary")).toBe("Accept-Language, Cookie");
      expect(response.headers.get("location")).toBe(
        locale === "en" ? null : `https://renai.im/${locale}${path === "/" ? "" : path}`,
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(f.fetcher).toHaveBeenCalledTimes(locale === "en" ? 1 : 0);
    expect(
      (await f.send("/ja/about", "GET", { "Accept-Language": header })).headers.get(
        "content-language",
      ),
    ).toBe("ja");
  },
);

test("roots redirect directly to Explore and explicit language choices survive reload", async () => {
  const f = await fixture();
  const root = await f.send("/");
  expect(root.status).toBe(307);
  expect(root.headers.get("location")).toBe("https://renai.im/explore");
  const normalized = await f.send("/en", "GET", { "Accept-Language": "ko-KR" });
  expect(normalized.status).toBe(307);
  expect(normalized.headers.get("location")).toBe("https://renai.im/explore");
  expect(normalized.headers.get("set-cookie")).toContain("renai.locale=en;");
  for (const [cookie, status, target] of [
    ["other=1; renai.locale=en", 307, "https://renai.im/explore"],
    ["renai.locale=invalid", 307, "https://renai.im/ko/explore"],
    ["renai.locale=ja", 307, "https://renai.im/ja/explore"],
  ] as const) {
    const response = await f.send("/", "GET", { "Accept-Language": "ko-KR", Cookie: cookie });
    expect(response.status).toBe(status);
    expect(response.headers.get("location")).toBe(target);
  }
  for (const [path, target] of [
    ["/ko", "/ko/explore"],
    ["/ja/", "/ja/explore"],
    ["/en/", "/explore"],
  ]) {
    const response = await f.send(`${path}?utm_source=friends&metrics=off`, "HEAD");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `https://renai.im${target}?utm_source=friends&metrics=off`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  }
  expect(f.fetcher).not.toHaveBeenCalled();
});
