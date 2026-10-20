import { expect, test } from "vitest";
import { workerFixture } from "../test/worker-fixture.ts";
import { authorization, tokenOf } from "../test/fixtures.ts";
import { readFile } from "node:fs/promises";
import { cloudflareFixture } from "../test/cloudflare-fixture.ts";

test("the real Worker and Durable Object serve bundled assets and correlate generation failures", async () => {
  const { runtime } = await workerFixture();
  const headers = { authorization };
  const health = await runtime.dispatchFetch("http://localhost:3729/health");
  expect(health.status).toBe(200);
  expect(health.headers.get("cache-control")).toBe("no-store");
  expect(await health.json()).toEqual({
    service: "admin",
    revision: process.env["GITHUB_SHA"] ?? "development",
    status: "ready",
    database: "ready",
    editor: "ready",
  });
  const page = await runtime.dispatchFetch("http://localhost:3729/new", { headers });
  expect(page.status).toBe(200);
  const markup = await page.text();
  expect(markup).toContain('type="module"');
  expect(markup).toContain('<link rel="icon" type="image/svg+xml" href="/brand.svg"/>');
  const icon = await runtime.dispatchFetch("http://localhost:3729/brand.svg", { headers });
  expect(icon.status).toBe(200);
  expect(icon.headers.get("content-type")).toBe("image/svg+xml");
  const discoveryIcon = await readFile(
    new URL("../../discovery/public/brand.svg", import.meta.url),
    "utf8",
  );
  expect(await icon.text()).toBe(discoveryIcon.replace("#c72c52", "#515151"));
  expect((await runtime.dispatchFetch("http://localhost:3729/brand.svg")).status).toBe(200);
  const script = await runtime.dispatchFetch("http://localhost:3729/pending.js", { headers });
  expect((await script.arrayBuffer()).byteLength).toBeGreaterThan(100_000);
  const styles = await runtime.dispatchFetch("http://localhost:3729/style.css", { headers });
  const stylesheet = await styles.text();
  expect(stylesheet).toContain(".document-tabs");
  expect(stylesheet).toContain(".editor-back");
  expect((await runtime.dispatchFetch("http://localhost:3729/api/personas")).status).toBe(200);
  expect((await runtime.dispatchFetch("http://localhost:3729/api/catalog")).status).toBe(401);
  const failed = await runtime.dispatchFetch("http://localhost:3729/personas", {
    method: "POST",
    headers: {
      ...headers,
      Origin: "http://localhost:3729",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      draft: tokenOf(markup),
      seed: "private diagnostic idea",
      gender: "female",
      intent: "character",
    }).toString(),
  });
  expect(failed.status).toBe(503);
  expect(await failed.text()).toContain(failed.headers.get("x-request-id")!);
});

test("local Worker-edge images are public from R2 while editor routes remain authenticated", async () => {
  const local = await workerFixture();
  const bucket = await local.runtime.getR2Bucket("IMAGES");
  const filename = "01234567-89ab-cdef-0123-456789abcdef.png";
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  await bucket.put(filename, bytes, { httpMetadata: { contentType: "image/png" } });
  const image = await local.runtime.dispatchFetch(`http://localhost:3729/images/${filename}`);
  expect(image.status).toBe(200);
  expect(image.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(bytes);
  const head = await local.runtime.dispatchFetch(`http://localhost:3729/images/${filename}`, {
    method: "HEAD",
  });
  expect(head.status).toBe(200);
  expect((await head.arrayBuffer()).byteLength).toBe(0);
  expect(
    (await local.runtime.dispatchFetch("http://localhost:3729/images/not-an-image.png")).status,
  ).toBe(404);
  expect(
    (
      await local.runtime.dispatchFetch(
        "http://localhost:3729/images/11234567-89ab-cdef-0123-456789abcdef.png",
      )
    ).status,
  ).toBe(404);
  expect((await local.runtime.dispatchFetch("http://localhost:3729/new")).status).toBe(401);
});

test("Worker health reports degraded when its real editor Durable Object cannot initialize", async () => {
  await workerFixture();
  const worker = await readFile(new URL("../dist/worker/entry.js", import.meta.url), "utf8");
  const { runtime } = await cloudflareFixture(
    worker,
    "export default {fetch(){return new Response(null,{status:503})}}",
  );
  const response = await runtime.dispatchFetch("http://localhost:3729/health");
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({
    service: "admin",
    status: "degraded",
    database: "ready",
    editor: "unavailable",
  });
});
