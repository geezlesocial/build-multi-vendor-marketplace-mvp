import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // TypeScript source tests are authoritative; the build emits duplicate JS
    // files under dist/ and those must not be discovered as a second suite.
    include: ['src/**/*.test.ts']
  }
});
