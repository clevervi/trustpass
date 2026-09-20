import { eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { mayRecord, mayRetireFrom } from "../domain/recording-authority.js";
import {
  type LifecycleActorKind,
  type LifecycleEventReason,
  type LifecycleEventType,
  lifecycleEvent,
} from "../schema/lifecycle-event.js";
import { type Product, type ProductStatus, product } from "../schema/product.js";

/** Raised by the status transition trigger. See drizzle/0002. */
const ILLEGAL_STATUS_TRANSITION = "TP001";

/**
 * Statuses this function will move a product to.
 *
 * `active` is deliberately absent. It means "in an owner's hands", and
 * ownership does not exist until v0.5.0 — so setting it today would be the
 * system asserting somebody owns a product when nothing has established that.
 * ADR 0008 and the roadmap both require it to become a consequence of ownership
 * rather than a label anyone can set, and leaving it out of this type means the
 * compiler enforces that rather than a reviewer.
 */
export type ChangeableStatus = Exclude<ProductStatus, "active" | "draft">;

export interface ChangeProductStatusInput {
  readonly productId: number;
  readonly to: ChangeableStatus;
  /** In what capacity the actor acted. Not who they are — that is TP-141. */
  readonly actorKind: LifecycleActorKind;
  /** Required when `actorKind` is `issuer`, forbidden otherwise. */
  readonly organizationId?: number | null;
  /**
   * Why.
   *
   * Required, and this is the whole point of the change: a suspension recorded
   * without a reason can never be explained afterwards, because the history is
   * append-only and nothing can go back and add one.
   */
  readonly reason: LifecycleEventReason;
  /** A report number, a case reference. Opaque, and never rendered as a claim. */
  readonly sourceReference?: string | null;
  /**
   * When it happened in the world, if that is not now.
   *
   * A theft reported today may have happened last month. Omitting it dates the
   * event to this transaction, which is right for something decided here.
   */
  readonly occurredAt?: Date;
}

export type ChangeProductStatusResult =
  | { readonly ok: true; readonly product: Product }
  | { readonly ok: false; readonly reason: "not_found" }
  | {
      readonly ok: false;
      readonly reason: "unauthorised_actor";
      readonly actorKind: LifecycleActorKind;
    }
  | {
      readonly ok: false;
      readonly reason: "illegal_transition";
      readonly from: ProductStatus;
      readonly to: ProductStatus;
    };

/**
 * Which event a move produces, read from **both** ends.
 *
 * The destination alone is not enough: `draft → registered` is an issuer
 * committing to a record for the first time, while `suspended → registered` is
 * a suspension being lifted. Recording both as "registered" would lose the fact
 * that something was once wrong, which is the fact a reader most needs.
 */
function eventFor(from: ProductStatus, to: ChangeableStatus): LifecycleEventType {
  if (to === "retired") return "product_retired";
  if (to === "suspended") return "product_suspended";
  return from === "suspended" ? "product_reinstated" : "product_registered";
}

/**
 * Moves a product's status and records why, as one act.
 *
 * The two writes are one transaction because a status with no explanation is
 * the defect this closes. If the event cannot be written the status must not
 * move — a product that became suspended for no recorded reason can never be
 * explained afterwards, since the history cannot be edited to add one.
 *
 * An illegal move and a missing product are outcomes rather than exceptions:
 * both are expected answers to a well-formed request, and modelling them as
 * errors would make every caller wrap this in a try block to read a normal
 * branch.
 *
 * **This does not authorise anything, and `insertProduct` now does.** That
 * difference is deliberate and it is a gap rather than a decision. `actorKind`
 * arrives from the caller and is written onto the event as a claim; no grant is
 * consulted, so nothing here establishes that the caller may act in the
 * capacity the record will assert.
 *
 * `insertProduct` takes an `authorise` callback that runs inside its
 * transaction, because #174 measured what deciding outside one costs — an event
 * naming a grant that had already been revoked at the instant the event claims.
 * The same shape applies here the moment this has a production caller, and it
 * has none today, which is the only reason this is not a live defect.
 *
 * Written where somebody adding that caller will be standing, rather than only
 * in #153.
 */
export async function changeProductStatus(
  db: Database,
  input: ChangeProductStatusInput,
): Promise<ChangeProductStatusResult> {
  try {
    return await db.transaction(async (tx) => {
      // Locked for update, so two concurrent changes cannot both read the same
      // `previous_state` and each record a move from it. The database trigger
      // would still refuse an illegal result, but the losing writer would have
      // recorded an event describing a move that never happened.
      const [current] = await tx
        .select({ id: product.id, status: product.status })
        .from(product)
        .where(eq(product.id, input.productId))
        .for("update");

      if (!current) {
        return { ok: false, reason: "not_found" };
      }

      if (current.status === input.to) {
        // Not an error and not an event. Nothing moved, so there is nothing to
        // record, and recording it would put a row in the history saying a
        // product stayed where it was.
        const [unchanged] = await tx.select().from(product).where(eq(product.id, input.productId));
        return { ok: true, product: unchanged as Product };
      }

      const type = eventFor(current.status, input.to);

      // Checked here as well as in the trigger, so a caller gets an outcome it
      // can act on rather than an exception it has to decode. The trigger is
      // still the authority: this is the same rule read early, not a second one.
      if (!mayRecord(input.actorKind, type) || !mayRetireFrom(input.actorKind, current.status)) {
        return { ok: false, reason: "unauthorised_actor", actorKind: input.actorKind };
      }

      const [updated] = await tx
        .update(product)
        .set({ status: input.to })
        .where(eq(product.id, input.productId))
        .returning();

      await tx.insert(lifecycleEvent).values({
        productId: input.productId,
        type,
        actorKind: input.actorKind,
        organizationId: input.organizationId ?? null,
        // `now()` rather than a JavaScript Date, for the reason TP-051 found:
        // `timestamptz` keeps microseconds and a `Date` does not, so a value
        // round-tripped through the client lands slightly off.
        occurredAt: input.occurredAt ?? sql`now()`,
        reason: input.reason,
        sourceReference: input.sourceReference ?? null,
        previousState: current.status,
        resultingState: input.to,
      });

      return { ok: true, product: updated as Product };
    });
  } catch (error) {
    if (sqlStateOf(error) === ILLEGAL_STATUS_TRANSITION) {
      // The trigger is the authority on which moves are legal. Catching its
      // code here rather than re-deciding in TypeScript keeps one answer to
      // that question instead of two that can drift apart.
      const [row] = await db
        .select({ status: product.status })
        .from(product)
        .where(eq(product.id, input.productId));

      return {
        ok: false,
        reason: "illegal_transition",
        from: row?.status ?? "draft",
        to: input.to,
      };
    }

    throw error;
  }
}

/** Drizzle wraps driver errors, so the SQLSTATE lives down the `cause` chain. */
function sqlStateOf(error: unknown): string | undefined {
  let current: unknown = error;

  while (current !== null && current !== undefined) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }

  return undefined;
}
