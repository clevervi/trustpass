import { and, eq, ne, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { type NewProduct, type Product, product } from "../schema/product.js";

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = "23505";

/** The partial unique index declared in `schema/product.ts`. */
const LIVE_SERIAL_INDEX = "product_live_issuer_serial_idx";

export type InsertProductResult =
  | { readonly ok: true; readonly product: Product }
  | { readonly ok: false; readonly reason: "duplicate_live_serial" };

/**
 * Drizzle wraps driver failures, so the SQLSTATE and the constraint name live
 * somewhere down the `cause` chain rather than on the error that surfaces.
 */
function violatedConstraint(error: unknown): { code?: string; constraint?: string } {
  let current: unknown = error;

  while (current !== null && current !== undefined) {
    const candidate = current as { code?: unknown; constraint_name?: unknown };
    if (typeof candidate.code === "string") {
      return {
        code: candidate.code,
        constraint:
          typeof candidate.constraint_name === "string" ? candidate.constraint_name : undefined,
      };
    }
    current = (current as { cause?: unknown }).cause;
  }

  return {};
}

/**
 * Inserts a product, reporting a duplicate live serial as an outcome rather
 * than an exception.
 *
 * Only that one constraint is translated. Any other failure rethrows, because
 * swallowing an unrecognised database error would turn a real fault into a
 * plausible-looking rejection the caller would report to a user as their
 * mistake.
 *
 * Query construction stays inside this package on purpose. The API layer never
 * touches the query builder, which is what keeps ADR 0005's rule — the internal
 * key never crosses the API boundary — structural rather than a review habit.
 */
export async function insertProduct(
  db: Database,
  values: NewProduct,
): Promise<InsertProductResult> {
  try {
    const [created] = await db.insert(product).values(values).returning();

    if (!created) {
      // A successful insert always returns its row. Reaching here means
      // something changed underneath us, not a case a caller can handle.
      throw new Error("Product insert returned no row.");
    }

    return { ok: true, product: created };
  } catch (error) {
    const violation = violatedConstraint(error);

    if (violation.code === UNIQUE_VIOLATION && violation.constraint === LIVE_SERIAL_INDEX) {
      return { ok: false, reason: "duplicate_live_serial" };
    }

    throw error;
  }
}

/**
 * Finds the live identity an issuer already holds for a serial.
 *
 * "Live" matches the partial unique index: every status except retired. Used to
 * tell a caller which TrustPass ID it collided with, which turns a duplicate
 * rejection into a recovery path for a client that timed out and retried.
 *
 * Serial comparison is lower-cased to match the index, or a lookup would miss
 * the very row that caused the conflict.
 */
export async function findLiveProductBySerial(
  db: Database,
  issuerId: number,
  serial: string,
): Promise<Product | undefined> {
  const [found] = await db
    .select()
    .from(product)
    .where(
      and(
        eq(product.issuerId, issuerId),
        sql`lower(${product.serial}) = lower(${serial})`,
        ne(product.status, "retired"),
      ),
    )
    .limit(1);

  return found;
}
