import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { build } from "bun";
import { build as buildWorker } from "esbuild";

// Content-hashed names let the edge serve browser assets immutably (`public/_headers`).
await Promise.all(
  ["public/assets", "dist/worker"].map((path) => rm(path, { recursive: true, force: true })),
);
const bundle = await build({
  entrypoints: ["src/pending-entry.mjs"],
  target: "browser",
  outdir: "public/assets",
  naming: "admin-[hash].[ext]",
  minify: true,
});
if (!bundle.success) throw new AggregateError(bundle.logs, "Admin browser build failed");
const css = (
  await Promise.all(
    ["src/style.css", "src/editor.css", "src/contact.css", "src/admin-layout.css"].map((file) =>
      readFile(file, "utf8"),
    ),
  )
).join("\n");
const stylesheet = `admin-${createHash("sha256").update(css).digest("hex").slice(0, 16)}.css`;
await writeFile(`public/assets/${stylesheet}`, css);
const assets = {
  script: `/assets/${basename(bundle.outputs[0].path)}`,
  stylesheet: `/assets/${stylesheet}`,
};

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
  // Workers instantiate WebAssembly only from uploaded modules, never from bytes at runtime.
  loader: { ".wasm": "copy" },
  define: {
    BUILD_REVISION: JSON.stringify(process.env.GITHUB_SHA ?? "development"),
    ADMIN_ASSETS: JSON.stringify(assets),
  },
  minify: true,
});
