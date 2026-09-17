export { createDatabase, type Database, type DatabaseOptions } from "./client.js";
export {
  assertTransition,
  canTransition,
  IllegalProductStatusTransition,
  isTerminal,
  nextStatuses,
  PRODUCT_STATUS_TRANSITIONS,
} from "./domain/product-status.js";
export { isDatabaseReachable } from "./health.js";
export {
  generateTrustPassId,
  isTrustPassId,
  parseTrustPassId,
  type TrustPassId,
  type TrustPassIdParseError,
  type TrustPassIdParseResult,
} from "./identity/trustpass-id.js";
export { findIssuerByRegistration } from "./repositories/issuer-repository.js";
export {
  findLiveProductBySerial,
  type InsertProductResult,
  insertProduct,
} from "./repositories/product-repository.js";
export * as schema from "./schema/index.js";
