import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

const frontendPort = Number(process.env.FRONTEND_PORT ?? process.env.PORT ?? 3617);

export default defineConfig({
  root: "web",
  plugins: [tailwindcss()],
  resolve: { alias: { "@": new URL("./web", import.meta.url).pathname } },
  server: {
    port: frontendPort,
    strictPort: true,
    proxy: {
      "^/api/": `http://127.0.0.1:${Number(process.env.BACKEND_PORT ?? 4617)}`,
    },
  },
  preview: {
    port: frontendPort,
    strictPort: true,
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      output: { entryFileNames: "assets/app.js", assetFileNames: "assets/style[extname]" },
    },
  },
});
