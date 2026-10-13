import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { cloudflareFixture } from "./cloudflare-fixture.ts";

export async function workerFixture() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  execFileSync("bun", [fileURLToPath(new URL("../scripts/build.mjs", import.meta.url))], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const [worker, script, css, editorCss] = await Promise.all([
    readFile(new URL("../dist/worker/entry.js", import.meta.url), "utf8"),
    readFile(new URL("../public/pending.js", import.meta.url), "utf8"),
    readFile(new URL("../public/style.css", import.meta.url), "utf8"),
    readFile(new URL("../public/editor.css", import.meta.url), "utf8"),
  ]);
  const assets = `const assets=${JSON.stringify({ "/style.css": css, "/editor.css": editorCss, "/pending.js": script })};export default {fetch(request){return new Response(assets[new URL(request.url).pathname] ?? '',{status:assets[new URL(request.url).pathname] ? 200 : 404})}}`;
  return cloudflareFixture(worker, assets);
}
