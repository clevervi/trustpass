import { defineConfig } from "drizzle-kit";

// The repo keeps a single .env at the root; CI and production inject
// DATABASE_URL directly, so a missing file is not an error.
try {
  process.loadEnvFile("../../.env");
} catch {
  // no-op: fall through to the ambient environment
}

const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env at the repository root.");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
