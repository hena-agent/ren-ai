import { expect, test } from "vitest";
import { workerFixture } from "../test/worker-fixture.ts";
import { authorization, tokenOf } from "../test/fixtures.ts";
import { readFile } from "node:fs/promises";

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
  expect(markup).toContain('<link rel="icon" type="image/svg+xml" href="/brand.svg"/>');
  const icon = await runtime.dispatchFetch("http://localhost:3729/brand.svg");
  expect(icon.status).toBe(200);
  expect(icon.headers.get("content-type")).toBe("image/svg+xml");
  const discoveryIcon = await readFile(
    new URL("../../discovery/public/brand.svg", import.meta.url),
    "utf8",
  );
  expect(await icon.text()).toBe(discoveryIcon.replace("#c72c52", "#515151"));
  const script = /<script src="(\/assets\/admin-[a-z0-9]+\.js)" type="module">/.exec(markup)![1]!;
  const stylesheet = /<link rel="stylesheet" href="(\/assets\/admin-[a-f0-9]{16}\.css)"/.exec(
    markup,
  )![1]!;
  // Edge-served without the Worker, so pages never wait on the editor Durable Object for them.
  const asset = async (path: string, type: string) => {
    const response = await runtime.dispatchFetch(`http://localhost:3729${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(type);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("x-request-id")).toBeNull();
    return response.text();
  };
  const bundle = await asset(script, "text/javascript");
  expect(bundle.length).toBeGreaterThan(100_000);
  expect(bundle).not.toContain("crypto-browserify");
  const styles = await asset(stylesheet, "text/css");
  expect(styles).toContain(".document-tabs");
  expect(styles).toContain(".editor-back");
  for (const path of ["/style.css", "/pending.js", "/_headers"]) {
    const removed = await runtime.dispatchFetch(`http://localhost:3729${path}`);
    expect(removed.status).toBe(401);
    await removed.arrayBuffer();
  }
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
  const { runtime } = await workerFixture({ ADMIN_PASSWORD: "" });
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
