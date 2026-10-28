import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer, createServerModuleRunner, defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";

const port = Number(process.env.PORT ?? 3867);
const proxy = {
  "^/discovery/": process.env.DISCOVERY_API_URL ?? "http://127.0.0.1:4879",
};
const root = fileURLToPath(new URL(".", import.meta.url));
const output = new URL("dist/client/", import.meta.url);

/** Writes the build-only pages that the static asset service serves without the Worker. */
const prerender = (): Plugin => ({
  name: "ren-ai-prerender",
  apply: "build",
  async closeBundle() {
    const server = await createServer({
      root,
      configFile: false,
      plugins: [react()],
      appType: "custom",
      logLevel: "silent",
      server: { middlewareMode: true },
    });
    const runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
    try {
      const { staticPages } =
        await runner.import<typeof import("./src/prerender.ts")>("/src/prerender.ts");
      const pages = await staticPages(await readFile(new URL("index.html", output), "utf8"));
      for (const [name, html] of Object.entries(pages))
        await writeFile(new URL(name, output), html);
    } finally {
      await runner.close();
      await server.close();
    }
  },
});

export default defineConfig({
  plugins: [react(), prerender()],
  build: { outDir: "dist/client" },
  server: { port, strictPort: true, proxy },
  preview: { port, strictPort: true, proxy },
});
