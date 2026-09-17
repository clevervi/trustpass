/**
 * Database schema barrel.
 *
 * Tables are added per epic so that every migration maps to a tracked task:
 *   TP-021 product, TP-040 warranty, TP-050 lifecycle_event.
 */

export {
  type Issuer,
  type IssuerVerificationStatus,
  issuer,
  issuerVerificationStatus,
  type NewIssuer,
} from "./issuer.js";
