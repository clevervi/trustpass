import type { TrustPassId } from "@trustpass/db";
import type { EnrolProductInput, EnrolProductResult } from "./enrolments/enrol-product.js";
import type { ReadPassportResult } from "./passports/read-passport.js";
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
  /**
   * Enrols a product nobody registered. Records that somebody entered a serial
   * — not that they own it, and not that anything about it has been checked.
   */
  enrolProduct: (input: EnrolProductInput) => Promise<EnrolProductResult>;
  /**
   * Reads a product's public passport. Takes an already-parsed identifier, so an
   * unverified string cannot reach the database and the mistyped-versus-unknown
   * decision is made before any lookup.
   */
  readPassport: (trustpassId: TrustPassId) => Promise<ReadPassportResult>;
}
