import { defineConfig } from "vitest/config";

/** HashKey Chain testnet fork suite: `pnpm test:fork` (sets FORK=1). Read-only RPC to the public testnet only. */
export default defineConfig({
  test: {
    include: ["test/fork/**/*.test.ts"],
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
});
