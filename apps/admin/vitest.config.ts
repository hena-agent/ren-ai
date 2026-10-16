import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@ren-ai/personas/profile-sections": fileURLToPath(
        new URL("../../packages/personas/src/profile-sections.ts", import.meta.url),
      ),
      "@ren-ai/personas/catalog": fileURLToPath(
        new URL("../../packages/personas/src/catalog.ts", import.meta.url),
      ),
      "@ren-ai/personas/markdown": fileURLToPath(
        new URL("../../packages/personas/src/markdown.tsx", import.meta.url),
      ),
      "@ren-ai/personas/profile": fileURLToPath(
        new URL("../../packages/personas/src/profile.ts", import.meta.url),
      ),
      "@ren-ai/personas": fileURLToPath(
        new URL("../../packages/personas/src/index.ts", import.meta.url),
      ),
    },
  },
  test: { include: ["src/**/*.test.{ts,tsx}"] },
});
