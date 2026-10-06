import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@ren-ai/onboarding/turnstile": fileURLToPath(
        new URL("../onboarding/src/turnstile.tsx", import.meta.url),
      ),
      "@ren-ai/onboarding": fileURLToPath(new URL("../onboarding/src/index.ts", import.meta.url)),
    },
  },
  test: { environment: "happy-dom", include: ["src/**/*.test.tsx"] },
});
import { fileURLToPath } from "node:url";
