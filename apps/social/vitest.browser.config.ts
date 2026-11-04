import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/*.integration.ts"],
    testTimeout: 30000,
    // Setup runs sequential CLI commands with individual 15-second process limits.
    hookTimeout: 35000,
  },
});
