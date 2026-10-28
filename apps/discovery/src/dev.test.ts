// @vitest-environment node
import { readFile } from "node:fs/promises";
import { Schema } from "effect";
import { expect, test } from "vitest";

test("Discovery development serves only the frontend, with no separate catalog listener", async () => {
  const manifest = Schema.decodeUnknownSync(
    Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) }),
  )(JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")));
  const deployment = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");

  expect(manifest.scripts["dev"]).toBe("vite --host 127.0.0.1");
  expect(manifest.scripts["dev:worker"]).toBeUndefined();
  expect(manifest.scripts["build"]).toBe("vite build");
  expect(deployment).not.toContain("d1_databases");
  expect(deployment).toMatch(/"run_worker_first":\s*\[/);
  // Home is still prerendered; the Worker checks locale preferences before serving it.
  expect(deployment).toContain('"/"');
  expect(deployment).toContain('"/explore"');
  expect(deployment).toContain('"/personas/*"');
});
