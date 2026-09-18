import { defineConfig } from "drizzle-kit";

// The repo keeps a single .env at the root; CI and production inject
// DATABASE_URL directly, so a missing file is not an error.
try {
  process.loadEnvFile("../../.env");
} catch {
  // no-op: fall through to the ambient environment
}

/**
 * `generate` is the one command that needs no database.
 *
 * It diffs the TypeScript schema against drizzle-kit's own snapshot and never
 * opens a connection — verified by running it against an unroutable address.
 * Demanding a credential for it forced every caller that only wants to check
 * for drift, CI included, to invent one, and an invented credential in a
 * workflow file is exactly what a secret scanner should object to. One did
 * (`secrets:S6698`), and it was right: the answer is not to silence the rule
 * but to stop needing the credential.
 *
 * Read from `argv[2]`, the subcommand position, rather than searching the whole
 * of `argv` — a path containing the word would otherwise waive the check. The
 * default is to require it, so an unrecognised command errs toward asking.
 */
const connects = process.argv[2] !== "generate";
const url = process.env.DATABASE_URL;

if (connects && !url) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env at the repository root.");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  // Empty only on the `generate` path above, where nothing reads it.
  dbCredentials: { url: url ?? "" },
  strict: true,
  verbose: true,
});
