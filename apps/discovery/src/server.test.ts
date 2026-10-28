// @vitest-environment node
import { afterEach, expect, test, vi } from "vitest";
import { publicPersonas } from "../test/public-personas.ts";
import { readPublicBootstrap } from "./public-routing.ts";
import { fixture, animePreview, photoPreview } from "../test/server.ts";

afterEach(() => vi.restoreAllMocks());

test("a direct profile request includes readable public HTML, canonical SEO, style-specific previews and safe bootstrap", async () => {
  const f = await fixture();
  const name = '지아 <script>alert("private")</script> $&';
  f.fetcher.mockResolvedValueOnce(
    Response.json([
      {
        ...publicPersonas[0],
        name,
        description: "PRIVATE DESCRIPTION",
        state: "PRIVATE STATE",
        prompt: "PRIVATE PROMPT",
        memory: "PRIVATE MEMORY",
      },
      publicPersonas[1],
    ]),
  );
  const response = await f.send("/ko/personas/jia?style=photo&tracking=ignored");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toContain("text/html");
  const html = await response.text();
  expect(html).toContain("햇살 좋은 날엔 같이 걸어요.");
  expect(html).toContain("좋아하는 것");
  expect(html).toContain(
    'src="https://persona-images.renai.im/thumbnails/00000000-0000-0000-0000-000000000002.jpg"',
  );
  expect(html).toContain('<link rel="canonical" href="https://renai.im/ko/personas/jia"');
  expect(html).toContain(
    '<meta property="og:url" content="https://renai.im/ko/personas/jia?style=photo&amp;preview=v2"',
  );
  expect(html).toContain(`<meta property="og:image" content="${photoPreview}"`);
  expect(html).toContain('name="twitter:card" content="summary_large_image"');
  expect(html).toContain('property="og:image:type" content="image/jpeg"');
  expect(html).toContain('property="og:image:width" content="1200"');
  expect(html).toContain('property="og:image:height" content="630"');
  expect(html).toContain(`property="og:image:secure_url" content="${photoPreview}"`);
  expect(html).toContain(`name="twitter:image" content="${photoPreview}"`);
  expect(f.fetcher).toHaveBeenCalledOnce();
  expect(f.PORTRAITS.get).not.toHaveBeenCalled();
  expect(html).toContain('type="application/ld+json"');
  expect(html).toContain('"@type":"CreativeWork"');
  expect(html).toContain('class="discovery-shell"');
  expect(html).toContain('class="profile-details"');
  expect(html.match(/<title>/g)).toHaveLength(1);
  expect(html.match(/name="description"/g)).toHaveLength(1);
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("$&");
  expect(html).not.toMatch(/PRIVATE (DESCRIPTION|STATE|PROMPT|MEMORY)/);
  const bootstrap = /<script id="public-personas" type="application\/json">(.*?)<\/script>/.exec(
    html,
  )![1]!;
  expect(bootstrap).not.toContain("<");
  expect(readPublicBootstrap(bootstrap)).toEqual({
    people: [{ ...publicPersonas[0], name }, publicPersonas[1]],
  });
  expect(f.fetcher).toHaveBeenCalledWith(
    new URL("https://api.example/discovery/profiles"),
    expect.objectContaining({
      cache: "no-store",
      headers: {
        "X-Request-ID": response.headers.get("x-request-id"),
        "Content-Type": "application/json",
      },
    }),
  );
  expect(f.log).toHaveBeenCalledWith(
    expect.objectContaining({
      requestId: response.headers.get("x-request-id"),
      stage: "request",
      outcome: "completed",
      personaId: "jia",
      style: "photo",
    }),
  );
  expect(f.log.mock.calls[0]![0].durationMs).toBeGreaterThanOrEqual(0);
});

test("the sitemap exposes current profile links without a separate directory or frontend rebuild", async () => {
  const f = await fixture();
  expect((await f.send("/personas")).status).toBe(404);
  const xml = await f.send("/sitemap.xml");
  expect(xml.headers.get("content-type")).toContain("application/xml");
  const body = await xml.text();
  expect(body).toContain("<loc>https://renai.im/ko/personas/jia</loc>");
  expect(body).toContain("<loc>https://renai.im/ko/explore</loc>");
  expect(body).not.toContain("<loc>https://renai.im/personas</loc>");
  expect(body).toContain(`<image:loc>${publicPersonas[0]!.portraits!.anime}</image:loc>`);
  f.fetcher.mockResolvedValueOnce(Response.json([publicPersonas[1]]));
  expect(await (await f.send("/sitemap.xml")).text()).not.toContain("/personas/jia");
  f.fetcher.mockResolvedValueOnce(Response.json([publicPersonas[1]]));
  const removed = await f.send("/ko/personas/jia");
  expect(removed.status).toBe(404);
  expect(removed.headers.get("x-robots-tag")).toBe("noindex");
  expect(await removed.text()).toContain('name="robots" content="noindex,follow"');
  expect(f.log).toHaveBeenLastCalledWith(expect.objectContaining({ status: 404, level: "warn" }));
});

test("profiles without photos, structured profiles or a style query still have public content and metadata", async () => {
  const f = await fixture();
  const html = await (await f.send("/ko/personas/subin?style=invalid")).text();
  expect(html).toContain("반가워요.");
  expect(html).toContain("이 스타일의 사진이 아직 없어요.");
  expect(html).toContain(
    'name="description" content="반가워요. — Ren AI의 가상 AI 페르소나. iMessage로 일상을 나눠요."',
  );
  expect(html).toContain('property="og:image" content="https://renai.im/social-ko-v2.png"');
  expect(html).toContain('property="og:image:width" content="1200"');
  expect(html).toContain('property="og:image:height" content="630"');
  expect(html).toContain('name="twitter:card" content="summary_large_image"');
  const normal = await (await f.send("/ko/personas/jia?style=anime")).text();
  expect(normal).toContain(`<meta property="og:image" content="${animePreview}"`);
});

test("routing handles HEAD, invalid paths, trailing slashes, methods, robots and static assets without unnecessary Catalog requests", async () => {
  const f = await fixture();
  const robots = await f.send("/robots.txt");
  expect(await robots.text()).toContain("Sitemap: https://renai.im/sitemap.xml");
  for (const path of ["/personas/", "/personas/invalid/id", "/personas/%3Cscript%3E"])
    expect((await f.send(path)).status).toBe(404);
  for (const path of ["/ko/personas/jia/?style=photo"]) {
    const response = await f.send(path);
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(
      `https://renai.im${path.replace(/\/(?=\?|$)/, "")}`,
    );
  }
  const method = await f.send("/personas", "POST");
  expect(method.status).toBe(405);
  expect(method.headers.get("allow")).toBe("GET, HEAD");
  expect(f.fetcher).not.toHaveBeenCalled();
  const head = await f.send("/ko/personas/jia", "HEAD");
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  await f.send("/assets/browser.js");
  expect(f.assets).toHaveBeenLastCalledWith(
    expect.objectContaining({ url: "https://renai.im/assets/browser.js" }),
  );
});

test.each(["http", "decode", "network", "assets"])(
  "%s failures return retryable 503s with correlated payload-safe diagnostics",
  async (failure) => {
    const f = await fixture();
    if (failure === "http")
      f.fetcher.mockResolvedValueOnce(new Response("PRIVATE UPSTREAM", { status: 502 }));
    if (failure === "decode")
      f.fetcher.mockResolvedValueOnce(Response.json([{ secret: "PRIVATE DECODE PAYLOAD" }]));
    if (failure === "network")
      f.fetcher.mockRejectedValueOnce(
        Object.assign(new Error("PRIVATE URL AND PROMPT"), { code: "ECONNRESET" }),
      );
    if (failure === "assets")
      f.assets.mockResolvedValueOnce(new Response("PRIVATE ASSET", { status: 500 }));
    const response = await f.send("/ko/personas/jia?style=photo&secret=PRIVATE QUERY");
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    const requestId = response.headers.get("x-request-id");
    expect(await response.text()).toContain(requestId);
    const events = f.log.mock.calls.map(([event]) => event);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      requestId,
      operation: "discovery.public",
      level: "error",
      outcome: "failed",
      personaId: "jia",
      style: "photo",
      stage:
        failure === "assets"
          ? "assets.template"
          : failure === "decode"
            ? "catalog.decode"
            : "catalog.read",
    });
    expect(events[1]).toMatchObject({ requestId, stage: "request", status: 503 });
    expect(events[0]).toMatchObject(
      failure === "http"
        ? { upstreamStatus: 502, code: "CATALOG_UNAVAILABLE" }
        : failure === "network"
          ? { causeCode: "ECONNRESET" }
          : {},
    );
    expect(JSON.stringify(events)).not.toContain("PRIVATE");
  },
);

test("health reports artifact identity and Catalog readiness independently of static assets", async () => {
  const f = await fixture();
  const response = await f.send("/health");
  expect(await response.json()).toEqual({
    service: "discovery",
    revision: "development",
    status: "ready",
    dependencies: { catalog: { status: "ready" }, preview: { status: "ready" } },
  });
  f.fetcher.mockRejectedValueOnce(new TypeError("secret"));
  const degraded = await f.send("/health");
  expect(degraded.status).toBe(503);
  expect(await degraded.json()).toMatchObject({
    status: "degraded",
    dependencies: { catalog: { status: "degraded" } },
  });
  expect(f.assets).toHaveBeenCalledWith(
    expect.objectContaining({ url: "https://renai.im/og-watermark-v2.png" }),
  );
});

test("English home remains a prerendered asset after locale negotiation", async () => {
  const f = await fixture();
  const response = await f.send("/");
  expect(response.status).toBe(200);
  expect(f.assets.mock.lastCall?.[0].url).toBe("https://renai.im/");
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.log).toHaveBeenCalledWith(expect.objectContaining({ status: 200 }));
  const korean = await f.send("/ko");
  expect(await korean.text()).toContain('<html lang="ko">');
  expect(f.fetcher).not.toHaveBeenCalled();
});

test("explorer HTML renders a first page sampled in the browser's language", async () => {
  const f = await fixture();
  const response = await f.send("/ja/explore", "GET", {
    "Accept-Language": "fr-FR,fr;q=0.9,JA;q=0.8,ko;q=0.7",
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const explore = await response.text();
  expect(explore).toContain('class="discovery-shell"');
  expect(explore).toContain('class="profile-card"');
  expect(explore).toContain('lang="ja"');
  expect(explore).toContain("<h2>백지아<!-- -->, 26</h2>");
  expect(explore).toContain("커피와 산책을 좋아해요.");
  expect(explore).toMatch(
    /<link rel="preload" as="image" href="https:\/\/persona-images\.renai\.im\/thumbnails\/00000000-0000-0000-0000-000000000001\.jpg" fetchPriority="high"\/>/,
  );
  expect(explore).not.toContain("만날 사람들을 불러오고 있어요.");
  const bootstrap = /<script id="public-personas" type="application\/json">(.*?)<\/script>/.exec(
    explore,
  )![1]!;
  expect(readPublicBootstrap(bootstrap)).toEqual({
    people: publicPersonas,
    page: { locale: "ja", nextCursor: "next-page" },
  });
  expect(f.fetcher).toHaveBeenCalledExactlyOnceWith(
    new URL("https://api.example/discovery/personas?locale=ja"),
    expect.objectContaining({
      cache: "no-store",
      headers: { "X-Request-ID": response.headers.get("x-request-id") },
    }),
  );
  expect(explore).not.toContain('href="/personas"');
  expect(explore).toContain('name="robots" content="index,follow,max-image-preview:large"');
  expect(explore).toContain('<link rel="canonical" href="https://renai.im/ja/explore"');
  const head = await f.send("/ja/explore", "HEAD");
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  expect(f.fetcher).toHaveBeenCalledOnce();
});

test.each(["http", "decode", "network", "timeout"])(
  "an explorer sampling %s failure returns the browser-loading shell with correlated payload-safe diagnostics",
  async (failure) => {
    const f = await fixture();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    if (failure === "http")
      f.fetcher.mockResolvedValueOnce(new Response("PRIVATE UPSTREAM", { status: 502 }));
    if (failure === "decode")
      f.fetcher.mockResolvedValueOnce(
        Response.json({ people: [{ secret: "PRIVATE DECODE PAYLOAD" }], nextCursor: null }),
      );
    if (failure === "network")
      f.fetcher.mockRejectedValueOnce(
        Object.assign(new Error("PRIVATE URL"), { code: "ECONNRESET" }),
      );
    if (failure === "timeout")
      f.fetcher.mockRejectedValueOnce(new DOMException("PRIVATE", "TimeoutError"));
    const response = await f.send("/explore?style=photo");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Loading people to meet.");
    expect(html).not.toContain('class="profile-card"');
    expect(html).not.toContain('id="public-personas"');
    expect(f.fetcher).toHaveBeenCalledExactlyOnceWith(
      new URL("https://api.example/discovery/personas?locale=en"),
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(timeout).toHaveBeenCalledExactlyOnceWith(3_000);
    expect(timeout).toHaveReturnedWith(f.fetcher.mock.calls[0]![1]!.signal);
    const requestId = response.headers.get("x-request-id");
    const events = f.log.mock.calls.map(([event]) => event);
    expect(events).toEqual([
      expect.objectContaining({
        requestId,
        operation: "discovery.public",
        style: "photo",
        outcome: "failed",
        level: "error",
        stage: failure === "decode" ? "catalog.decode" : "catalog.read",
        code: failure === "decode" ? "CATALOG_INVALID" : "CATALOG_UNAVAILABLE",
      }),
      expect.objectContaining({ requestId, stage: "request", outcome: "completed", status: 200 }),
    ]);
    expect(events[0]).toMatchObject(
      failure === "http"
        ? { upstreamStatus: 502 }
        : failure === "network"
          ? { causeCode: "ECONNRESET" }
          : failure === "timeout"
            ? { causeName: "TimeoutError" }
            : { upstreamStatus: 200 },
    );
    expect(JSON.stringify(events)).not.toContain("PRIVATE");
  },
);

test("render failures keep the persona rendition URL and report a correlated retryable image failure instead of a brand substitution", async () => {
  const f = await fixture();
  f.output.mockRejectedValue(
    Object.assign(new Error("PRIVATE IMAGE PAYLOAD"), { name: "ImagesError", code: 9412 }),
  );
  const response = await f.send("/ko/personas/jia?style=photo&private=PRIVATE QUERY");
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain(`property="og:image" content="${photoPreview}"`);
  expect(html).toContain("햇살 좋은 날엔 같이 걸어요.");
  const failed = await f.send(new URL(photoPreview).pathname);
  expect(failed.status).toBe(503);
  expect(failed.headers.get("retry-after")).toBe("30");
  expect(await failed.text()).not.toContain("social-");
  expect(f.log).toHaveBeenCalledTimes(3);
  expect(f.log.mock.calls[1]![0]).toMatchObject({
    requestId: failed.headers.get("x-request-id"),
    personaId: "jia",
    style: "photo",
    stage: "image.render",
    causeName: "ImagesError",
    causeCode: "9412",
    level: "error",
  });
  expect(f.log.mock.calls[2]![0]).toMatchObject({ stage: "request", status: 503, level: "error" });
  expect(JSON.stringify(f.log.mock.calls)).not.toContain("PRIVATE");
});

test("owned local sources still advertise same-origin HTTPS renditions, and image sitemaps escape query strings", async () => {
  const f = await fixture();
  const persona = {
    ...publicPersonas[0]!,
    portraits: { anime: "http://127.0.0.1:3729/images/00000000-0000-0000-0000-000000000001.jpg" },
  };
  f.fetcher.mockResolvedValueOnce(Response.json([persona]));
  const html = await (await f.send("/ko/personas/jia")).text();
  expect(html).toContain(`property="og:image:secure_url" content="${animePreview}"`);
  f.fetcher.mockResolvedValueOnce(
    Response.json([{ id: persona.id, imageUrl: `${persona.portraits.anime}?x=1&y=2` }]),
  );
  expect(await (await f.send("/sitemap.xml")).text()).toContain("?x=1&amp;y=2");
});

test("advertised rendition routes return JPEGs and reject withdrawn or stale gallery photos before cache access", async () => {
  const f = await fixture();
  const response = await f.send(new URL(animePreview).pathname);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/jpeg");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toBe("rendered-persona-preview");
  expect(f.PORTRAITS.get).toHaveBeenCalledExactlyOnceWith(
    "00000000-0000-0000-0000-000000000001.jpg",
  );
  f.cache.match.mockResolvedValue(
    new Response("cached", { headers: { "Content-Type": "image/jpeg" } }),
  );
  const head = await f.send(new URL(animePreview).pathname, "HEAD");
  expect(head.headers.get("content-type")).toBe("image/jpeg");
  expect(await head.text()).toBe("");
  f.fetcher.mockResolvedValueOnce(Response.json([publicPersonas[1]]));
  expect((await f.send(new URL(animePreview).pathname)).status).toBe(404);
  expect(
    (await f.send(new URL(animePreview).pathname.replace(/[^/]+$/, "unknown.v2.jpg"))).status,
  ).toBe(404);
  expect(f.cache.match).toHaveBeenCalledTimes(2);
  expect(f.PORTRAITS.get).toHaveBeenCalledOnce();
});

test("an unavailable preview executor degrades health even while the public Catalog is ready", async () => {
  const f = await fixture();
  f.IMAGE_TRANSFORMS.info.mockRejectedValue(
    Object.assign(new Error("PRIVATE provider payload"), { code: 9412 }),
  );
  const response = await f.send("/health");
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    dependencies: { catalog: { status: "ready" }, preview: { status: "degraded" } },
  });
  expect(f.log.mock.calls[0]![0]).toMatchObject({
    stage: "health.preview",
    causeCode: "9412",
    code: "PREVIEW_UNAVAILABLE",
  });
  expect(JSON.stringify(f.log.mock.calls)).not.toContain("PRIVATE");
});
