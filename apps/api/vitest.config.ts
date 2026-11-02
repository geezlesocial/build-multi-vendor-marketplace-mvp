import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // TypeScript source tests are authoritative; the build emits duplicate JS
    // files under dist/ and those must not be discovered as a second suite.
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text", "json-summary"],
      reportsDirectory: "./coverage",
      thresholds: {
        statements: 15,
        branches: 15,
        functions: 19,
        lines: 17,
      },
    },
  },
});
