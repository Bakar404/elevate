import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "scripts/lib/**/*.test.ts"],
    testTimeout: 120_000,
    pool: "forks",
  },
});
