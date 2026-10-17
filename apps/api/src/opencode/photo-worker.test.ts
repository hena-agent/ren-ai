import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { Schema } from "effect";
import { Base64 } from "@opencode/schema/prompt";
import { expect, test } from "vitest";
import { trackRuntime } from "../../test/cloudflare-test-fixture.ts";

test("the Worker acknowledges and reads a large native photo without exhausting the regexp stack", async () => {
  const bundle = await build({
    entryPoints: [new URL("../../test/opencode-photo-worker.ts", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker"],
    target: "es2023",
    external: ["cloudflare:workers", "node:*"],
    write: false,
  });
  const runtime = trackRuntime(
    new Miniflare({
      workers: [
        {
          config: {
            name: "opencode-photo-test",
            compatibilityDate: "2026-10-13",
            compatibilityFlags: ["nodejs_compat"],
            manifest: {
              mainModule: "index.js",
              modules: { "index.js": { type: "esm", contents: bundle.outputFiles[0]!.text } },
            },
          },
        },
      ],
    }),
  );
  const response = await runtime.dispatchFetch("https://worker.example", {
    method: "POST",
    body: "AAAA".repeat(2 * 1024 * 1024),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    forwarded: true,
    acknowledged: true,
    historyPreserved: true,
  });
});

test("native photo validation retains the Base64 alphabet, complete groups and padding rules", () => {
  const valid = Schema.is(Base64);
  for (const value of ["", "Zg==", "Zm8=", "Zm9v", "++++////", "AB=="])
    expect(valid(value)).toBe(true);
  for (const value of [
    "A",
    "AA",
    "AAA",
    "====",
    "A===",
    "AAAA=",
    "AAA\n",
    "AA=A",
    "AAAA\n",
    "AAAA====",
    "____",
    "----",
  ])
    expect(valid(value)).toBe(false);
});
