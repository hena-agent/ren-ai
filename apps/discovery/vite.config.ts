import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer, createServerModuleRunner, defineConfig } from "vite";
import type { Plugin, ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { pageRedirect } from "./src/page-redirect.ts";

const port = Number(process.env.PORT ?? 3867);
const proxy = {
  "^/discovery/": process.env.DISCOVERY_API_URL ?? "http://127.0.0.1:4879",
};
const root = fileURLToPath(new URL(".", import.meta.url));
const output = new URL("dist/client/", import.meta.url);

function installRedirects(server: Pick<ViteDevServer, "middlewares">) {
  server.middlewares.use((request, response, next) => {
    if (request.method !== "GET" && request.method !== "HEAD") return next();
    const headers = new Headers();
    for (const name of ["cookie", "accept-language"]) {
      const value = request.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
    const redirect = pageRedirect(
      new Request(new URL(request.url!, `http://${request.headers.host}`), { headers }),
    );
    if (!redirect) return next();
    response.writeHead(redirect.status, Object.fromEntries(redirect.headers));
    response.end();
  });
}

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
  plugins: [
    react(),
    prerender(),
    {
      name: "ren-ai-page-redirects",
      configureServer: installRedirects,
      configurePreviewServer: installRedirects,
    },
  ],
  build: { outDir: "dist/client" },
  server: { port, strictPort: true, proxy },
  preview: { port, strictPort: true, proxy },
});
