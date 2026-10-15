import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { expect, test } from "vitest";
import { stopRuntimes, trackRuntime } from "../test/cloudflare-test-fixture.ts";

const text = (value: string) => ({ type: "text" as const, value });

test("the retained source entry runs the Worker with Durable Object SQLite, never local serving SQL", async () => {
  const bundle = await build({
    entryPoints: [new URL("./server-entry.ts", import.meta.url).pathname],
    loader: { ".md": "text" },
    bundle: true,
    format: "esm",
    platform: "neutral",
    external: ["cloudflare:workers", "node:*"],
    write: false,
    metafile: true,
  });
  const inputs = Object.keys(bundle.metafile.inputs).join("\n");
  expect(inputs).not.toContain("sql-sqlite-bun");
  expect(inputs).not.toContain("sql-sqlite-node");
  expect(inputs).not.toContain("composition.test-helper");
  const runtime = trackRuntime(
    new Miniflare({
      workers: [
        {
          config: {
            name: "source-entry-test",
            compatibilityDate: "2026-10-13",
            compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
            exports: { ApiApplication: { type: "durable-object", storage: "sqlite" } },
            manifest: {
              mainModule: "index.js",
              modules: { "index.js": { type: "esm", contents: bundle.outputFiles[0]!.text } },
            },
            env: {
              APPLICATION: {
                type: "durable-object",
                worker: "source-entry-test",
                exportName: "ApiApplication",
              },
              PERSONA_CATALOG_URL: text("https://admin.invalid"),
              TOKEN_CATALOG: text("private-catalog"),
              TURNSTILE_SECRET: text("private-turnstile"),
              TOKEN_MANAGEMENT: text("private-management"),
              API_MSG_URL: text("https://executor.invalid"),
              TOKEN_EXECUTOR: text("private-executor"),
              REN_AI_APPLICATION_TOKEN: text("private-application"),
              BOOTSTRAP_ONLY: text("true"),
            },
          },
        },
      ],
    }),
  );
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const health = await runtime.dispatchFetch("https://app.test/health");
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({
        database: "ready",
        storage: "durable-object-sqlite",
        bootstrapOnly: true,
      });
    }
    const paused = await runtime.dispatchFetch("https://app.test/rpc", { method: "POST" });
    expect(paused.status).toBe(503);
  } finally {
    await stopRuntimes();
  }
});
