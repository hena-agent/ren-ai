import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const port = Number(process.env.PORT ?? 3867);
const proxy = {
  "^/discovery/": process.env.DISCOVERY_API_URL ?? "http://127.0.0.1:4879",
  "^/api/personas$": process.env.DISCOVERY_WORKER_URL ?? "http://127.0.0.1:4873",
};
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist/client" },
  server: { port, strictPort: true, proxy },
  preview: { port, strictPort: true, proxy },
});
