import type { AuthenticatedPrincipal, TrustPassId } from "@trustpass/db";
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
  /**
   * Resolves a presented credential to the actor it belongs to, or to null.
   *
   * Returns null for every reason a credential can fail, so the HTTP layer has
   * nothing to leak even if it wanted to — ADR 0014 §7.
   */
  authenticate: (presented: string | undefined) => Promise<AuthenticatedPrincipal | null>;
  /**
   * Registers a product against an existing issuer, on behalf of a principal.
   *
   * The principal is a separate argument from the input for the reason ADR
   * 0014 §6 gives: the first says what is being described, the second says who
   * is describing it, and a signature that mixes them invites a handler to
   * take identity from the wrong one.
   */
  registerProduct: (
    input: RegisterProductInput,
    principal: AuthenticatedPrincipal,
  ) => Promise<RegisterProductResult>;
  /**
   * Enrols a product nobody registered. Records that somebody entered a serial
   * — not that they own it, and not that anything about it has been checked.
   */
  enrolProduct: (
    input: EnrolProductInput,
    principal: AuthenticatedPrincipal,
  ) => Promise<EnrolProductResult>;
  /**
   * Reads a product's public passport. Takes an already-parsed identifier, so an
   * unverified string cannot reach the database and the mistyped-versus-unknown
   * decision is made before any lookup.
   */
  readPassport: (trustpassId: TrustPassId) => Promise<ReadPassportResult>;
}
