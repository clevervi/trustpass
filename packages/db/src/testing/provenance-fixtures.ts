import { sql } from "drizzle-orm";
import { generateTrustPassId } from "../identity/trustpass-id.js";
import type { NewLifecycleEvent } from "../schema/lifecycle-event.js";
import type { NewProduct } from "../schema/product.js";

/**
 * Shared fixtures for the suites that assert provenance itself.
 *
 * Two suites make the same claims from different angles — one on a single
 * connection, one across two — and both need the same two shapes: a product
 * that exists, and a transition event that explains a move. Written twice they
 * were the same code, and the pair has to stay identical or the suites stop
 * being comparable.
 *
 * Not the same thing as `with-provenance.ts`, and the distinction matters.
 * That module writes a product *and* its event together, for tests whose
 * subject is something else. These are raw values, for tests that assemble the
 * transaction by hand because the assembly is what they are asserting.
 */

/** The two statuses the provenance suites move products between. */
export type MovableStatus = "registered" | "suspended";

/**
 * A holder-enrolled product, which needs no issuer.
 *
 * Returns a factory rather than a value because serials must be unique per row
 * and per test run: `product_live_holder_serial_idx` allows one live holder
 * record per serial, so a fixed serial would make the second call in a suite
 * fail on an index that has nothing to do with what is being tested.
 */
export function holderProducts(prefix: string): () => NewProduct {
  let n = 0;

  return () => {
    n += 1;

    return {
      trustpassId: generateTrustPassId(),
      organizationId: null,
      brand: "ASUS",
      model: "ROG Strix RTX 5070 Ti",
      serial: `${prefix}-${n}`,
      category: "gpu",
      status: "registered",
      origin: "holder",
    };
  };
}

/**
 * The event that explains one status move, for tests that write it by hand.
 *
 * The type and actor capacity are derived rather than passed: an issuer may not
 * reinstate and a holder may not suspend, so a fixture that let a caller choose
 * would trip the authority trigger and report `TP003` for a test asserting
 * something about `TP004`.
 *
 * `occurredAt` is `now()` and not a JavaScript `Date`. The database sets
 * `recorded_at`, and a `Date` taken on the host is later than it — the host
 * clock runs ahead of the container's — so the event would claim to have
 * happened after it was recorded and fail a check constraint instead.
 */
export function transitionEventValues(
  productId: number,
  from: MovableStatus,
  to: MovableStatus,
): NewLifecycleEvent {
  const suspending = to === "suspended";

  return {
    productId,
    type: suspending ? "product_suspended" : "product_reinstated",
    actorKind: "authority",
    organizationId: null,
    occurredAt: sql`now()` as unknown as Date,
    reason: suspending ? "theft_report" : "dispute_resolved",
    previousState: from,
    resultingState: to,
  };
}
