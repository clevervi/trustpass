import type { AppDependencies } from "../dependencies.js";

/**
 * Builds the dependency set with working defaults, so a test states only what
 * it actually cares about. A test that has to spell out every dependency stops
 * saying what it is testing.
 */
export function buildDependencies(overrides: Partial<AppDependencies> = {}): AppDependencies {
  return {
    version: "0.0.0-test",
    checkDatabase: async () => true,
    registerProduct: async () => {
      throw new Error("registerProduct was called but this test did not provide one.");
    },
    ...overrides,
  };
}
