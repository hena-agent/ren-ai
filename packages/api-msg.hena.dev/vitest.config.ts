import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["./test/offline.setup.ts"],
    pool: "forks",
    maxWorkers: 1,
  },
});
