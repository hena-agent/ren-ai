import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { cloudflareFixture, type WorkerBundle } from "./cloudflare-fixture.ts";

async function builtWorker(): Promise<WorkerBundle> {
  const root = fileURLToPath(new URL("..", import.meta.url));
  execFileSync("bun", [fileURLToPath(new URL("../scripts/build.mjs", import.meta.url))], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = new URL("../dist/worker/", import.meta.url);
  const wasm = (await readdir(output)).filter((name) => name.endsWith(".wasm"));
  return {
    source: await readFile(new URL("entry.js", output), "utf8"),
    wasm: Object.fromEntries(
      await Promise.all(
        wasm.map(
          async (name) => [name, new Uint8Array(await readFile(new URL(name, output)))] as const,
        ),
      ),
    ),
  };
}

export async function workerFixture(text?: Record<string, string>) {
  return cloudflareFixture(await builtWorker(), undefined, text);
}
