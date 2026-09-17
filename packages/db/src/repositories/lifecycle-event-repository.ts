import { desc, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import {
  type LifecycleActorKind,
  type LifecycleEventReason,
  type LifecycleEventType,
  lifecycleEvent,
} from "../schema/lifecycle-event.js";
import type { ProductStatus } from "../schema/product.js";

/**
 * One entry in a product's history, as anything outside this package may see it.
 *
 * Deliberately not the table row: `id`, `productId`, `issuerId` and
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
