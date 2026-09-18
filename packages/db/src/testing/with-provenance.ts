import { eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import {
  type LifecycleActorKind,
  type LifecycleEventType,
  lifecycleEvent,
} from "../schema/lifecycle-event.js";
import { type NewProduct, type Product, type ProductStatus, product } from "../schema/product.js";

/**
 * Inserts a product and the event that explains it, in one transaction.
 *
 * Since the provenance triggers landed, a bare `db.insert(product)` fails at
 * COMMIT — which is the point: a row with no recorded origin is invisible,
 * because nothing later can tell that its history is missing rather than empty.
 *
 * This exists for tests whose subject is something else entirely: a check
 * constraint, an index, a repository. They need a product that exists, not a
 * product whose provenance they are asserting, and writing the event by hand in
 * every fixture would make each of them test two things and obscure which one
 * failed.
 *
 * Tests about provenance itself do **not** use this. They write the raw insert
 * and assert the refusal.
 */
export async function insertProductWithProvenance(
  db: Database,
  values: NewProduct,
): Promise<Product> {
  // A record has an issuer or it has a holder origin, never neither (TP-047).
  // A fixture that named no issuer used to get a supply_chain default and fail
  // the check, so the helper settles it rather than making every caller think
  // about a rule their test is not about.
  const coherent: NewProduct =
    values.origin || values.organizationId
      ? values
      : { ...values, origin: "holder", organizationId: null };

  return await db.transaction(async (tx) => {
    const [created] = await tx.insert(product).values(coherent).returning();

    if (!created) {
      throw new Error("Product insert returned no row.");
    }

    await tx.insert(lifecycleEvent).values({
      productId: created.id,
      // Matches what the real write paths record for the same shapes, so a
      // fixture cannot drift into a pairing the authority rules forbid.
      type:
        created.status === "registered" && created.organizationId
          ? "product_registered"
          : "record_enrolled",
      actorKind: created.organizationId ? "issuer" : "holder",
      organizationId: created.organizationId ?? null,
      occurredAt: created.createdAt,
    });

    return created;
  });
}

/**
 * Moves a product's status and records the event that explains it.
 *
 * For tests whose subject is the transition rules themselves. They assert which
 * moves the database allows; since 0010 a move also needs a reason, and writing
 * one by hand in every case would bury the rule under bookkeeping.
 *
 * An illegal move still raises TP001 at the update, before any event is
 * written — which is the ordering the provenance triggers were arranged to
 * preserve, and what lets this helper be used by a suite that asserts refusals.
 */
export async function moveProductStatus(
  db: Database,
  productId: number,
  to: ProductStatus,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ status: product.status })
      .from(product)
      .where(eq(product.id, productId));

    const from = current?.status;
    await tx.update(product).set({ status: to }).where(eq(product.id, productId));

    // A no-op update changes nothing, so there is nothing to explain and the
    // deferred trigger does not ask.
    if (!from || from === to) return;

    await tx.insert(lifecycleEvent).values({
      productId,
      type: EVENT_FOR[to],
      // The capacity each type is allowed to: holder cannot suspend, an issuer
      // cannot reinstate, only the system activates. A fixture that guessed
      // would trip the authority trigger and report the wrong rule.
      actorKind: ACTOR_FOR[to],
      organizationId: null,
      // now(), not a JavaScript Date. recorded_at defaults to the transaction
      // timestamp, and a Date taken after the transaction opened is later than
      // it — so the event would claim to have happened after it was recorded.
      occurredAt: sql`now()`,
      reason: to === "suspended" ? "theft_report" : "investigation_closed",
      previousState: from,
      resultingState: to,
    });
  });
}

const EVENT_FOR: Readonly<Record<ProductStatus, LifecycleEventType>> = {
  draft: "record_enrolled",
  registered: "product_reinstated",
  active: "product_activated",
  suspended: "product_suspended",
  retired: "product_retired",
};

const ACTOR_FOR: Readonly<Record<ProductStatus, LifecycleActorKind>> = {
  draft: "holder",
  registered: "authority",
  active: "system",
  suspended: "authority",
  retired: "authority",
};
