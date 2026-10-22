import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Windows process startup makes Git-backed integration fixtures much slower.
    // Production command deadlines and tests with explicit timeout assertions
    // retain their own budgets; avoid timing out a test while its Git job runs.
    testTimeout: process.platform === "win32" ? 60_000 : 15_000,
    ...(process.platform === "win32" ? { maxWorkers: 2 } : {}),
  },
});
