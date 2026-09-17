import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  // @trustpass/db is published as TypeScript source inside the workspace, so it
  // must be compiled into the artifact instead of resolved at runtime.
  noExternal: ["@trustpass/db"],
});
