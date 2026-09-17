import type { ProductStatus } from "../schema/product.js";

/**
 * Which status a product may move to from each status it can be in.
 *
 * This is the single definition. The database enforces the same set through a
 * trigger, because a rule that lives only in application code is bypassed by
 * the first path that writes without going through it — and status gates what
 * the public passport is allowed to claim.
 *
 * The two copies cannot be merged into one artefact, so `product-status`
 * integration tests compare every source-to-target pair against the database
 * and fail if the two ever disagree. Drift becomes a red test rather than a
 * silent divergence.
 *
 * Reasoning per edge:
 *
 * - `draft` is a row that exists and claims nothing. It can be committed to, or
 *   abandoned, and nothing else.
 * - `registered` means a TrustPass record exists for this product. It does not
 *   say who vouches for it: a manufacturer registering at the factory and a
 *   person enrolling a device they hold both land here, and which one it was is
 *   carried by the record's origin and by its first event, not by its status.
 *   From there a product is activated once ownership exists, flagged before it
 *   ever sells, or retired.
 * - `active` means ownership has been established. It is a consequence of that
 *   happening, never a label anyone sets — and it is not a precondition for a
 *   passport being worth reading, which every state is.
 * - `suspended` exists because something is wrong: a fraud flag, a theft report,
 *   a disputed claim. It deliberately cannot return to `active` in one step.
 *   Clearing a suspension returns the product to `registered`, and activating it
 *   again is a separate, separately recorded act. A product that quietly becomes
 *   active again erases the reason it was ever suspended.
 * - `retired` is terminal. A product that can come back from end-of-life makes
 *   "retired" mean nothing on a passport.
 */
export const PRODUCT_STATUS_TRANSITIONS: Readonly<Record<ProductStatus, readonly ProductStatus[]>> =
  {
    draft: ["registered", "retired"],
    registered: ["active", "suspended", "retired"],
    active: ["suspended", "retired"],
    suspended: ["registered", "retired"],
    retired: [],
  } as const;

/**
 * Raised when a caller asks for a move the lifecycle does not permit.
 *
 * Carries both states rather than only a message, so an HTTP layer can report
 * them without parsing prose.
 */
export class IllegalProductStatusTransition extends Error {
  readonly from: ProductStatus;
  readonly to: ProductStatus;

  constructor(from: ProductStatus, to: ProductStatus) {
    super(`Product status cannot move from "${from}" to "${to}".`);
    this.name = "IllegalProductStatusTransition";
    this.from = from;
    this.to = to;
  }
}

/**
 * True when the move is permitted.
 *
 * Staying in the same status is always permitted: an update that changes a
 * brand or a serial leaves the status alone, and treating that as a transition
 * would block every ordinary write.
 */
export function canTransition(from: ProductStatus, to: ProductStatus): boolean {
  if (from === to) {
    return true;
  }

  return PRODUCT_STATUS_TRANSITIONS[from].includes(to);
}

/** Throws `IllegalProductStatusTransition` when the move is not permitted. */
export function assertTransition(from: ProductStatus, to: ProductStatus): void {
  if (!canTransition(from, to)) {
    throw new IllegalProductStatusTransition(from, to);
  }
}

/** Every status a product may reach from here, excluding staying put. */
export function nextStatuses(from: ProductStatus): readonly ProductStatus[] {
  return PRODUCT_STATUS_TRANSITIONS[from];
}

/** True when no move out of this status exists. */
export function isTerminal(status: ProductStatus): boolean {
  return PRODUCT_STATUS_TRANSITIONS[status].length === 0;
}
