import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@ren-ai/onboarding/turnstile": fileURLToPath(
        new URL("../../packages/onboarding/src/turnstile.tsx", import.meta.url),
      ),
      "@ren-ai/onboarding": fileURLToPath(
        new URL("../../packages/onboarding/src/index.ts", import.meta.url),
      ),
    },
  },
  test: { environment: "happy-dom", include: ["src/**/*.test.ts", "src/**/*.test.tsx"] },
});
