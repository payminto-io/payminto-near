import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each package keeps its own module cache: the default is one folder at the repository root, which every
    // package resets at startup, so packages run in parallel deleted it under each other (`pnpm -r test`).
    fsModuleCachePath: "node_modules/.vitest-cache",
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
