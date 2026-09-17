export { createDatabase, type Database, type DatabaseOptions } from "./client.js";
export { isDatabaseReachable } from "./health.js";
export {
  generateTrustPassId,
  isTrustPassId,
  parseTrustPassId,
  type TrustPassId,
  type TrustPassIdParseError,
  type TrustPassIdParseResult,
} from "./identity/trustpass-id.js";
export * as schema from "./schema/index.js";
