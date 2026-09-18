export { createDatabase, type Database, type DatabaseOptions } from "./client.js";
export {
  assertTransition,
  canTransition,
  IllegalProductStatusTransition,
  isTerminal,
  nextStatuses,
  PRODUCT_STATUS_TRANSITIONS,
} from "./domain/product-status.js";
export { discloseSerial, type SerialDisclosure } from "./domain/serial-disclosure.js";
export {
  CLAIM_STATES,
  CLAIM_SUBJECTS,
  type ClaimState,
  type ClaimSubject,
  computeVerificationClaims,
  type VerificationClaim,
  type VerificationClaimsInput,
} from "./domain/verification-claims.js";
export { isDatabaseReachable } from "./health.js";
export {
  generateTrustPassId,
  isTrustPassId,
  parseTrustPassId,
  type TrustPassId,
  type TrustPassIdParseError,
  type TrustPassIdParseResult,
} from "./identity/trustpass-id.js";
export {
  type EnrolProductInput,
  type EnrolProductResult,
  enrolProduct,
  findLiveHolderEnrolment,
} from "./repositories/enrolment-repository.js";
export { findIssuerByRegistration } from "./repositories/issuer-repository.js";
export {
  findHistoryByTrustPassId,
  findProductHistory,
  type ProductHistoryEntry,
} from "./repositories/lifecycle-event-repository.js";
export {
  findLiveProductBySerial,
  findProductByTrustPassId,
  type InsertProductResult,
  insertProduct,
  type ProductWithIssuer,
} from "./repositories/product-repository.js";
export {
  type ChangeableStatus,
  type ChangeProductStatusInput,
  type ChangeProductStatusResult,
  changeProductStatus,
} from "./repositories/product-status-repository.js";
export * as schema from "./schema/index.js";
export type {
  LifecycleActorKind,
  LifecycleEvent,
  LifecycleEventReason,
  LifecycleEventType,
  NewLifecycleEvent,
} from "./schema/lifecycle-event.js";
