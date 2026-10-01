import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@ren-ai/personas": fileURLToPath(new URL("../personas/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["./test/offline.setup.ts"],
    pool: "forks",
    maxWorkers: 1,
    testTimeout: 20_000,
  },
});
