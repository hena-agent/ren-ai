import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@ren-ai/personas/image-url": fileURLToPath(
        new URL("../../packages/personas/src/image-url.ts", import.meta.url),
      ),
      "@ren-ai/personas/languages": fileURLToPath(
        new URL("../../packages/personas/src/languages.ts", import.meta.url),
      ),
      "@ren-ai/personas/birth-date": fileURLToPath(
        new URL("../../packages/personas/src/birth-date.ts", import.meta.url),
      ),
      "@ren-ai/personas/profile-sections": fileURLToPath(
        new URL("../../packages/personas/src/profile-sections.ts", import.meta.url),
      ),
      "@ren-ai/personas/catalog": fileURLToPath(
        new URL("../../packages/personas/src/catalog.ts", import.meta.url),
      ),
      "@ren-ai/personas/public-profile-view": fileURLToPath(
        new URL("../../packages/personas/src/public-profile-view.tsx", import.meta.url),
      ),
      "@ren-ai/personas/public-profile": fileURLToPath(
        new URL("../../packages/personas/src/public-profile.ts", import.meta.url),
      ),
      "@ren-ai/personas/profile-projection": fileURLToPath(
        new URL("../../packages/personas/src/profile-projection.ts", import.meta.url),
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
