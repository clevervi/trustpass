import { defaultExclude, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Plain module tests: no DOM, no jsdom, no testing library.
    environment: "node",
    include: ["app/**/*.test.ts", "lib/**/*.test.ts"],
    // Vitest's default exclude is only node_modules and .git, so without this
    // every run walks the Next build output, which grows without bound.
    exclude: [...defaultExclude, "**/.next/**"],
  },
});
