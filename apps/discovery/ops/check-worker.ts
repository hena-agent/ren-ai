import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { unstable_dev } from "wrangler";

// Exercise the built pages and real ASSETS binding without production dependencies.
let catalogReads = 0;
const catalog = createServer((request, response) => {
  assert.equal(request.url, "/discovery/personas?locale=en");
  catalogReads++;
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ people: [], nextCursor: null }));
});
catalog.listen(0, "127.0.0.1");
await once(catalog, "listening");
const address = catalog.address();
assert(address && typeof address !== "string");

try {
  const worker = await unstable_dev("worker/entry.ts", {
    config: "wrangler.jsonc",
    local: true,
    ip: "127.0.0.1",
    port: 0,
    inspectorPort: 0,
    persist: false,
    vars: { DISCOVERY_API_URL: `http://127.0.0.1:${address.port}` },
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true },
  });
  try {
    for (const [path, locale] of [
      ["/about", "en"],
      ["/ko/about", "ko"],
      ["/ja/about", "ja"],
      ["/explore", "en"],
    ]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await fetch(`http://${worker.address}:${worker.port}${path}`, {
          method,
          redirect: "manual",
          headers: { "Accept-Language": "en" },
          signal: AbortSignal.timeout(10_000),
        });
        assert.equal(response.status, 200, `${method} ${path}`);
        assert.equal(response.headers.get("content-language"), locale);
        assert.match(response.headers.get("content-type") ?? "", /text\/html/);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert(response.headers.get("x-request-id"));
        const html = await response.text();
        if (method === "HEAD") assert.equal(html, "");
        else {
          assert(html.includes(`<html lang="${locale}">`));
          assert(html.includes(path === "/explore" ? 'id="public-personas"' : 'class="about"'));
        }
        process.stdout.write(`${method} ${path}: verified\n`);
      }
    }
    assert.equal(catalogReads, 1, "only GET /explore reads the Catalog");
    for (const [path, target] of [
      ["/", "/explore"],
      ["/ko", "/ko/explore"],
      ["/ja/", "/ja/explore"],
      ["/en", "/explore"],
    ]) {
      const response = await worker.fetch(`${path}?utm_source=check`, {
        redirect: "manual",
        headers: { "Accept-Language": "en" },
      });
      assert.equal(response.status, 307);
      assert.equal(new URL(response.headers.get("location")!).pathname, target);
      assert.equal(new URL(response.headers.get("location")!).search, "?utm_source=check");
      process.stdout.write(`redirect ${path}: verified\n`);
    }
    for (const path of ["/missing", "/ko/missing", "/home", "/personas", "/ja/health"]) {
      const response = await worker.fetch(path, { redirect: "manual" });
      assert.equal(response.status, 404, path);
      assert.equal(response.headers.get("x-robots-tag"), "noindex");
      assert((await response.text()).includes("/explore"));
      process.stdout.write(`404 ${path}: verified\n`);
    }
  } finally {
    await worker.stop();
  }
} finally {
  await new Promise<void>((resolve, reject) =>
    catalog.close((error) => (error ? reject(error) : resolve())),
  );
}
