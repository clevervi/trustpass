import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { lifecycleEvent } from "../schema/lifecycle-event.js";
import { type NewProduct, type Product, product } from "../schema/product.js";

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = "23505";

/** The partial unique index declared in `schema/product.ts`. */
const LIVE_HOLDER_SERIAL_INDEX = "product_live_holder_serial_idx";

export type EnrolProductResult =
  | { readonly ok: true; readonly product: Product }
  | { readonly ok: false; readonly reason: "duplicate_live_serial" };

/**
 * What a caller may set when enrolling a product they hold.
 *
 * `issuerId` and `origin` are absent on purpose rather than optional: an
 * enrolment is a holder enrolment, and letting either be passed in would let a
 * caller claim a company's standing through this path.
 */
export type EnrolProductInput = Omit<NewProduct, "issuerId" | "origin" | "status">;

/**
 * Enrols a product nobody registered.
 *
 * The product and the record of where it came from are written together, for
 * the reason `insertProduct` gives: a row with no provenance is invisible,
 * because nothing later can tell that its history is missing rather than empty.
 *
 * Status is `registered` and never `active`. Per ADR 0008 `active` means
 * ownership was established, and somebody entering a serial establishes nothing
 * about who holds the object. It is not a parameter because it is not a choice.
 */
export async function enrolProduct(
  db: Database,
  values: EnrolProductInput,
): Promise<EnrolProductResult> {
  try {
    return await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(product)
        .values({ ...values, issuerId: null, origin: "holder", status: "registered" })
        .returning();

      if (!created) {
        throw new Error("Product insert returned no row.");
      }

      await tx.insert(lifecycleEvent).values({
        productId: created.id,
        // Per ADR 0007 as amended: what begins here is the TrustPass record,
        // not the product. The object is older than this row.
        type: "record_enrolled",
        actorKind: "holder",
        issuerId: null,
        reason: "holder_request",
        // `now()` rather than a JavaScript Date: `timestamptz` keeps
        // microseconds and a Date does not, so a round-tripped value lands
        // slightly before the row it describes.
        occurredAt: sql`now()`,
      });

      return { ok: true, product: created };
    });
  } catch (error) {
    const violation = violatedConstraint(error);

    if (violation.code === UNIQUE_VIOLATION && violation.constraint === LIVE_HOLDER_SERIAL_INDEX) {
      return { ok: false, reason: "duplicate_live_serial" };
    }

    throw error;
  }
}

/**
 * The live holder enrolment already holding a serial.
 *
 * Used to tell a caller which TrustPass ID it collided with, which turns a
 * rejection into a recovery path for a client that timed out and retried rather
 * than an invitation to try a different serial.
 */
export async function findLiveHolderEnrolment(
  db: Database,
  serial: string,
): Promise<Product | undefined> {
  const [found] = await db
    .select()
    .from(product)
    .where(
      and(
        isNull(product.issuerId),
        eq(sql`lower(${product.serial})`, serial.toLowerCase()),
        ne(product.status, "retired"),
      ),
    )
    .limit(1);

  return found;
}

/** Drizzle wraps driver errors, so the SQLSTATE lives down the `cause` chain. */
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
