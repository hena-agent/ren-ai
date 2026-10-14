import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
  entryPoints: ["worker/entry.ts"],
  bundle: true,
  loader: { ".md": "text" },
  format: "esm",
  platform: "neutral",
  conditions: ["workerd", "worker"],
  mainFields: ["module", "main"],
  target: "es2023",
  outfile: "dist/worker/entry.js",
  external: ["cloudflare:workers", "node:*"],
  minify: true,
});
