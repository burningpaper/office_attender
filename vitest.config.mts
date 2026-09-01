import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "tests/**/*.test.ts"],
    /**
     * Many of these are integration tests: they spin up Postgres in WASM and
     * push a whole workbook through it. Vitest's 5s default is not a realistic
     * budget for that, and produced failures that looked like flakes but were
     * just the clock - one run finished in 5096ms and was reported as broken.
     */
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
  resolve: {
    alias: { "@": path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".") },
  },
});
