import { expect, test } from "vitest";
import { workerFixture } from "../test/worker-fixture.ts";
import { authorization, tokenOf } from "../test/fixtures.ts";

test("the real Worker and Durable Object serve bundled assets and correlate generation failures", async () => {
  const { runtime } = await workerFixture();
  const headers = { authorization };
  const page = await runtime.dispatchFetch("http://localhost:3729/new", { headers });
  expect(page.status).toBe(200);
  const markup = await page.text();
  expect(markup).toContain('type="module"');
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
