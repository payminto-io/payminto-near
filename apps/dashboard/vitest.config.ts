import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
    // Node 25+ ships its own localStorage, which warns when touched without a file; jsdom provides the one tests use.
    execArgv: ["--no-experimental-webstorage"],
    // The slowest jsdom suites take about 4 s on an idle machine, so vitest's 5 s default failed them whenever the
    // monorepo's suites ran in parallel (`pnpm -r test`, CI). The other packages set 20 to 180 s for the same reason.
    testTimeout: 30_000,
  },
});
