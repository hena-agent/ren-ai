import { build } from "esbuild";

await build({
  entryPoints: ["worker/entry.mjs"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  conditions: ["workerd", "worker"],
  mainFields: ["module", "main"],
  target: "es2023",
  outfile: "dist/worker/entry.js",
  external: ["node:*"],
  minify: true,
});
