/**
 * Fixtures for integration tests in other packages.
 *
 * Exported because the provenance guarantee applies across the repository: a
 * product written by an API test needs its first event just as much as one
 * written here, and every suite reimplementing that would be four copies of a
 * rule that has to stay identical.
 */

export {
  type Transaction,
  twoConnections,
  whileHoldingATransaction,
} from "./overlapping-transactions.js";
export {
  holderProducts,
  type MovableStatus,
  transitionEventValues,
} from "./provenance-fixtures.js";
export { expectSqlState, SqlState, sqlMessageOf, sqlStateOf } from "./sql-state.js";
export { insertProductWithProvenance, moveProductStatus } from "./with-provenance.js";
