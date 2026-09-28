import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "web",
  plugins: [tailwindcss()],
  resolve: { alias: { "@": new URL("./web", import.meta.url).pathname } },
  server: {
    port: Number(process.env.PORT ?? 3000),
    strictPort: true,
    proxy: {
      "^/(sessions|session|new|input|tick|reset|export|import)(?:\\?|$)": "http://127.0.0.1:3001",
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      output: { entryFileNames: "assets/app.js", assetFileNames: "assets/style[extname]" },
    },
  },
});
