import { build } from "bun";
import { build as buildWorker } from "esbuild";

const bundle = await build({
  entrypoints: ["src/pending-entry.mjs"],
  target: "browser",
  outdir: "public",
  naming: "pending.js",
  minify: true,
});
if (!bundle.success) throw new AggregateError(bundle.logs, "Admin browser build failed");

// Workers export conditions select edge SSR and DOM-free Markdown dependencies.
await buildWorker({
  entryPoints: ["worker/entry.mjs"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  conditions: ["workerd", "worker"],
  mainFields: ["module", "main"],
  target: "es2023",
  outfile: "dist/worker/entry.js",
  external: ["node:*", "cloudflare:workers"],
  define: { BUILD_REVISION: JSON.stringify(process.env.GITHUB_SHA ?? "development") },
  minify: true,
});
