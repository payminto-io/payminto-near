import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // The HashKey Chain fork suite needs network access and runs on its own: `pnpm test:fork` (FORK=1).
    exclude: ["**/node_modules/**", "test/fork/**"],
  },
});
