import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  assetsInclude: ["**/*.md"],
  resolve: {
    alias: {
      "@ren-ai/personas/languages": fileURLToPath(
        new URL("../../packages/personas/src/languages.ts", import.meta.url),
      ),
      "@ren-ai/personas/catalog": fileURLToPath(
        new URL("../../packages/personas/src/catalog.ts", import.meta.url),
      ),
      "@ren-ai/personas/public-profile": fileURLToPath(
        new URL("../../packages/personas/src/public-profile.ts", import.meta.url),
      ),
      "@ren-ai/personas/profile": fileURLToPath(
        new URL("../../packages/personas/src/profile.ts", import.meta.url),
      ),
      "@ren-ai/onboarding": fileURLToPath(
        new URL("../../packages/onboarding/src/index.ts", import.meta.url),
      ),
      "@ren-ai/personas": fileURLToPath(
        new URL("../../packages/personas/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["./test/offline.setup.ts"],
    pool: "forks",
    testTimeout: 20_000,
  },
});
