import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { lifecycleEvent } from "../schema/lifecycle-event.js";
import { type NewProduct, type Product, product } from "../schema/product.js";
import { UNIQUE_VIOLATION, violatedConstraint } from "./constraint-violation.js";

/** The partial unique index declared in `schema/product.ts`. */
const LIVE_HOLDER_SERIAL_INDEX = "product_live_holder_serial_idx";

export type EnrolProductResult =
  | { readonly ok: true; readonly product: Product }
  | { readonly ok: false; readonly reason: "duplicate_live_serial" };

/**
 * What a caller may set when enrolling a product they hold.
 *
 * `organizationId`, `origin` and `status` are absent on purpose rather than
 * optional: an enrolment is a holder enrolment, and letting any of them be
 * passed in would let a caller claim a company's standing through this path.
 *
 * This is the structural half of ADR 0014 §6. The request body carries no
 * identity because the type it becomes has nowhere to put one — which is a
 * stronger guarantee than a handler remembering not to read one.
 */
export type EnrolProductInput = Omit<NewProduct, "organizationId" | "origin" | "status">;

/**
 * Who is recording this, as distinct from what is being recorded.
 *
 * A separate parameter rather than a field on the input, deliberately. The
 * input type's whole purpose is having nowhere to put an identity — ADR 0014
 * §6 — and adding one to it would undo that at the only layer where it is
 * structural rather than a habit.
 *
 * Required, not optional. An optional identity is one that gets forgotten, and
 * being forgotten is precisely the state #141 exists to end.
 */
export interface RecordingActor {
  /** The authenticated principal. Never a value from a request body. */
  readonly actorId: number;
}

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
  actor: RecordingActor,
): Promise<EnrolProductResult> {
  try {
    return await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(product)
        .values({
          ...values,
          organizationId: null,
          origin: "holder",
          status: "registered",
        })
        .returning();

      if (!created) {
        throw new Error("Product insert returned no row.");
      }

      await tx.insert(lifecycleEvent).values({
        productId: created.id,
        // Per ADR 0007 as amended: what begins here is the TrustPass record,
        // not the product. The object is older than this row.
        type: "record_enrolled",
        // What kind of operation this is: a literal, never read from a request.
        actorKind: "holder",
        // Who did it: the authenticated principal, and the one value here that
        // is not a literal. The two are separate columns for the reason ADR
        // 0014 §6 gives — a body saying "authority" does not make its sender
        // one, and whether this actor may act as a holder is a grant lookup
        // that runs elsewhere (#152).
        actorId: actor.actorId,
        organizationId: null,
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
        isNull(product.organizationId),
        eq(sql`lower(${product.serial})`, serial.toLowerCase()),
        ne(product.status, "retired"),
      ),
    )
    .limit(1);

  return found;
}
