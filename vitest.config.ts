import { defineConfig } from "vitest/config";
import exceptions from "./quality-exceptions.json" with { type: "json" };

export default defineConfig({
  test: {
    projects: ["packages/*"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.{ts,tsx}"],
      exclude: [
        "**/*.test.{ts,tsx}",
        ...(exceptions.coverage as readonly { path: string }[]).map((entry) => entry.path),
      ],
      thresholds: { perFile: true, lines: 100, functions: 100, branches: 100, statements: 100 },
      reporter: ["text"],
    },
  },
});
