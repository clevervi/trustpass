import { sql } from "drizzle-orm";
import { createDatabase, type Database } from "../client.js";

/** The transaction handle Drizzle hands a `db.transaction` callback. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Two transactions, on two connections, overlapping in time.
 *
 * Every guarantee in `provenance.integration.test.ts` says something about
 * "this transaction", and until now every test asserting one ran on a single
 * connection. One connection cannot express the case those guarantees are
 * actually exposed to: two transactions that never overlap cannot borrow from
 * each other, so a suite built only from them can be completely green while the
 * property it claims to protect does not hold.
 *
 * The shape this reproduces:
 *
 * ```
 *   A  BEGIN, and a statement           <- opens first, so its transaction
 *                                          timestamp is the earlier one
 *   B      BEGIN
 *   B      write
 *   B      COMMIT                       <- visible to A under READ COMMITTED
 *   A  work
 *   A  COMMIT                           <- deferred triggers fire here
 * ```
 *
 * `holderOpens` is not ceremony. Measured against this database: a transaction's
 * timestamp is fixed by its **first statement**, not by `BEGIN` — a `BEGIN` with
 * nothing after it has not started anything, and A's timestamp would end up
 * later than B's write. Without that statement the ordering this helper is named
 * for does not exist, and a test built on it would pass for the wrong reason.
 */
export async function whileHoldingATransaction<T>(options: {
  /** The connection whose transaction stays open across the other's commit. */
  readonly holder: Database;
  /** A separate connection. The same pool would serialise instead of overlap. */
  readonly other: Database;
  /** Runs first, inside A, to pin its transaction. Defaults to `SELECT 1`. */
  readonly holderOpens?: (tx: Transaction) => Promise<unknown>;
  /** Runs entirely inside B, and commits, while A is still open. */
  readonly otherCommits: (tx: Transaction) => Promise<unknown>;
  /** Runs inside A afterwards. A commits when it returns. */
  readonly holderThen: (tx: Transaction) => Promise<T>;
}): Promise<T> {
  const { holder, other, holderOpens, otherCommits, holderThen } = options;

  return await holder.transaction(async (a) => {
    await (holderOpens ? holderOpens(a) : a.execute(sql`SELECT 1`));

    // A separate pool, so this is a genuinely concurrent transaction rather
    // than a nested one. Awaiting it means B has committed before A continues.
    await other.transaction(async (b) => {
      await otherCommits(b);
    });

    return await holderThen(a);
  });
}

/**
 * Two clients on separate pools, and one call that closes both.
 *
 * Separate pools rather than a larger `maxConnections` on one: Drizzle reserves
 * a pooled connection for the length of a transaction, so a single pool would
 * hand both transactions out of the same place, and exhausting it is a hang
 * rather than a failure — the worst way for a test to report anything.
 */
export function twoConnections(url: string): {
  readonly holder: Database;
  readonly other: Database;
  readonly close: () => Promise<void>;
} {
  const holder = createDatabase(url, { maxConnections: 2 });
  const other = createDatabase(url, { maxConnections: 2 });

  return {
    holder,
    other,
    close: async () => {
      await Promise.all([holder.$client.end(), other.$client.end()]);
    },
  };
}
