import { desc, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import type { TrustPassId } from "../identity/trustpass-id.js";
import {
  type LifecycleActorKind,
  type LifecycleEventReason,
  type LifecycleEventType,
  lifecycleEvent,
} from "../schema/lifecycle-event.js";
import { type ProductStatus, product } from "../schema/product.js";

/**
 * One entry in a product's history, as anything outside this package may see it.
 *
 * Deliberately not the table row: `id`, `productId`, `organizationId` and
 * `correctsEventId` are internal keys and never cross the API boundary per ADR
 * 0005. What a reader needs is what happened, when, in what capacity and why —
 * not the numbers this system files it under.
 */
export interface ProductHistoryEntry {
  readonly type: LifecycleEventType;
  readonly actorKind: LifecycleActorKind;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
  readonly reason: LifecycleEventReason | null;
  readonly previousState: ProductStatus | null;
  readonly resultingState: ProductStatus | null;
}

/**
 * Everything recorded about a product, newest first.
 *
 * Named columns rather than `select()`, for the same reason the passport lookup
 * uses them: a projection that lists what it returns cannot start leaking a
 * column somebody adds later.
 *
 * Ordered by when things happened, not by when they were recorded. A repair
 * from March learned about in September belongs in March — that is where a
 * reader will look for it, and ordering by `recordedAt` would tell the story of
 * this system's bookkeeping instead of the story of the product.
 */
export async function findProductHistory(
  db: Database,
  productId: number,
): Promise<readonly ProductHistoryEntry[]> {
  return await db
    .select({
      type: lifecycleEvent.type,
      actorKind: lifecycleEvent.actorKind,
      occurredAt: lifecycleEvent.occurredAt,
      recordedAt: lifecycleEvent.recordedAt,
      reason: lifecycleEvent.reason,
      previousState: lifecycleEvent.previousState,
      resultingState: lifecycleEvent.resultingState,
    })
    .from(lifecycleEvent)
    .where(eq(lifecycleEvent.productId, productId))
    .orderBy(desc(lifecycleEvent.occurredAt), desc(lifecycleEvent.id));
}

/**
 * A product's history, found by the identifier the outside world uses.
 *
 * One query with a join rather than "look up the product, then its events",
 * and that is not an optimisation. The product's internal key is what links the
 * two, and per ADR 0005 it must never leave this package — so the join has to
 * happen here. A caller that could pass an `id` in would be a caller that had
 * already been given one.
 *
 * An empty array means either no history or no such product. The passport read
 * has already established which, so distinguishing them here would only invite
 * a second lookup to answer a question nobody asked.
 */
export async function findHistoryByTrustPassId(
  db: Database,
  trustpassId: TrustPassId,
): Promise<readonly ProductHistoryEntry[]> {
  return await db
    .select({
      type: lifecycleEvent.type,
      actorKind: lifecycleEvent.actorKind,
      occurredAt: lifecycleEvent.occurredAt,
      recordedAt: lifecycleEvent.recordedAt,
      reason: lifecycleEvent.reason,
      previousState: lifecycleEvent.previousState,
      resultingState: lifecycleEvent.resultingState,
    })
    .from(lifecycleEvent)
    .innerJoin(product, eq(product.id, lifecycleEvent.productId))
    .where(eq(product.trustpassId, trustpassId))
    .orderBy(desc(lifecycleEvent.occurredAt), desc(lifecycleEvent.id));
}
