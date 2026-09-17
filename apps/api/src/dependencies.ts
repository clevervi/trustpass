import type { RegisterProductInput, RegisterProductResult } from "./products/register-product.js";

/**
 * Everything the HTTP layer needs from the outside world.
 *
 * Declared as plain functions rather than concrete clients so routes stay
 * testable without a running Postgres instance.
 */
export interface AppDependencies {
  /** Semver of the running service, surfaced by /health and /version. */
  version: string;
  /** Resolves false when the database is unreachable; must never throw. */
  checkDatabase: () => Promise<boolean>;
  /** Registers a product against an existing issuer. */
  registerProduct: (input: RegisterProductInput) => Promise<RegisterProductResult>;
}
