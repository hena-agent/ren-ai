import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export async function durableSocialFixture() {
  const root = await mkdtemp(join(tmpdir(), "social-durable-"));
  const bundle = await build({
    entryPoints: [new URL("./social-worker-entry.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker"],
    mainFields: ["module", "main"],
    external: ["cloudflare:workers", "node:*"],
    target: "es2023",
  });
  const start = () =>
    new Miniflare({
      resourcePersistencePath: root,
      workers: [
        {
          config: {
            name: "social-proof",
            compatibilityDate: "2026-10-13",
            compatibilityFlags: ["nodejs_compat"],
            exports: { SocialProof: { type: "durable-object", storage: "sqlite" } },
            manifest: {
              mainModule: "social.js",
              modules: { "social.js": { type: "esm", contents: bundle.outputFiles[0]!.text } },
            },
            env: {
              SOCIAL: { type: "durable-object", worker: "social-proof", exportName: "SocialProof" },
            },
          },
        },
      ],
    });
  let runtime = start();
  return {
    request: (path: string, body?: object) =>
      runtime.dispatchFetch(`https://proof${path}`, {
        method: body ? "POST" : "GET",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        ...(body && { body: JSON.stringify(body) }),
      }),
    replace: async () => {
      await runtime.dispose();
      runtime = start();
    },
    close: async () => {
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}
