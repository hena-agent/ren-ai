import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@ren-ai/personas": fileURLToPath(
        new URL("../../packages/personas/src/index.ts", import.meta.url),
      ),
    },
  },
  test: { include: ["src/**/*.test.{ts,tsx}"] },
});
