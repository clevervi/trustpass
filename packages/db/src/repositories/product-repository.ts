import type { Database } from "../client.js";
import { type NewProduct, type Product, product } from "../schema/product.js";

/**
 * Inserts a product and returns the stored row.
 *
 * Query construction stays inside this package on purpose. The API layer never
 * touches the query builder, which is what keeps ADR 0005's rule — the internal
 * key never crosses the API boundary — structural rather than a review habit.
 */
export async function insertProduct(db: Database, values: NewProduct): Promise<Product> {
  const [created] = await db.insert(product).values(values).returning();

  if (!created) {
    // A successful insert always returns its row. Reaching here means something
    // changed underneath us, not a case a caller can handle.
    throw new Error("Product insert returned no row.");
  }

  return created;
}
