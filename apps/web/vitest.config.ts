import { fileURLToPath } from "node:url";
import { defaultExclude, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The `@/` alias `tsconfig.json` defines. Vitest does not read tsconfig
    // paths, and without this a test cannot import anything under `app/` that
    // uses the alias — which is every route handler.
    //
    // That is why `qr.svg/route.ts` had no test: not an oversight, a test setup
    // that could not reach it. #196 measured the consequence — four security
    // guards on that route could be deleted with every check green.
    //
    // A pattern rather than a string key. A string key is matched against the
    // start of the specifier and the replacement is concatenated, which on
    // Windows produced `…\apps\weblib/passport-origin` and read as a missing
    // package rather than as a bad path.
    alias: [
      {
        find: /^@\//,
        replacement: `${fileURLToPath(new URL(".", import.meta.url)).replace(/\\/g, "/")}`,
      },
    ],
  },
  test: {
    // Plain module tests: no DOM, no jsdom, no testing library.
    environment: "node",
    include: ["app/**/*.test.ts", "lib/**/*.test.ts"],
    // Vitest's default exclude is only node_modules and .git, so without this
    // every run walks the Next build output, which grows without bound.
    exclude: [...defaultExclude, "**/.next/**"],
  },
});
