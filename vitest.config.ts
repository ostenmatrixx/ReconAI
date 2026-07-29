import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
    },
    projects: [
      {
        test: {
          name: "unit",
          include: ["apps/**/*.test.ts", "packages/**/*.test.ts", "scripts/**/*.test.mjs"],
          exclude: [
            "**/node_modules/**",
            "**/dist/**",
            "**/.next/**",
            "**/*.integration.test.ts",
            "**/*.tenant.test.ts",
            "packages/reconciliation/**/*.test.ts",
          ],
        },
      },
      {
        test: {
          name: "tenant",
          include: ["**/*.tenant.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
        },
      },
      {
        test: {
          name: "reconciliation",
          include: ["packages/reconciliation/**/*.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["**/*.integration.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
          fileParallelism: false,
          hookTimeout: 30_000,
          testTimeout: 15_000,
        },
      },
    ],
  },
});
