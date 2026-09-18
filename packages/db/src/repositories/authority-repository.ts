import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import type { LifecycleActorKind } from "../schema/actor-capacity.js";
import { capacityGrant, capacityGrantRevocation } from "../schema/capacity-grant.js";

/** A grant as it stood at the instant asked about. */
export interface HeldGrant {
  readonly id: number;
  readonly capacity: LifecycleActorKind;
  readonly organizationId: number | null;
  readonly scopeKind: "own_organization" | "country";
  readonly scopeCountry: string | null;
}

/**
 * Which grants an actor held at a given instant.
 *
 * The question ADR 0011 exists to keep answerable, and the reason grants are
 * append-only: reconstructing it must not depend on anybody having refrained
 * from an `UPDATE`.
 *
 * **`revokedAt > at`, never "no revocation exists".** A grant revoked in
 * September was valid in August. Excluding every revoked grant answers *"what
 * may this actor do now"* and silently destroys the answer to *"what could they
 * do then"* — and the two questions look identical from the call site, which is
 * why the difference is asserted by a test rather than left to reading.
 *
 * `at` is passed rather than defaulted to now(). An authorisation check asks
 * about this instant; a passport rendering a two-year-old event asks about that
 * one, and a function that quietly assumed the first would answer the second
 * wrongly while looking correct.
 */
export async function grantsHeldAt(
  db: Database,
  actorId: number,
  at: Date,
): Promise<readonly HeldGrant[]> {
  const rows = await db
    .select({
      id: capacityGrant.id,
      capacity: capacityGrant.capacity,
      organizationId: capacityGrant.organizationId,
      scopeKind: capacityGrant.scopeKind,
      scopeCountry: capacityGrant.scopeCountry,
    })
    .from(capacityGrant)
    .leftJoin(capacityGrantRevocation, eq(capacityGrantRevocation.grantId, capacityGrant.id))
    .where(
      and(
        eq(capacityGrant.actorId, actorId),
        lte(capacityGrant.effectiveFrom, at),
        or(isNull(capacityGrant.expiresAt), gt(capacityGrant.expiresAt, at)),
        // The clause the whole design rests on.
        or(isNull(capacityGrantRevocation.revokedAt), gt(capacityGrantRevocation.revokedAt, at)),
      ),
    )
    .orderBy(capacityGrant.id);

  return rows;
}

/**
 * Whether an actor could act in a capacity at an instant.
 *
 * Deliberately not "may act now". Every caller has to name the moment, because
 * the two questions are different and only one of them is the one being asked.
 *
 * This answers **who held what**. It does not answer whether that capacity may
 * record a particular event — `RECORDING_AUTHORITY` decides that, and ADR 0009
 * keeps the two separate so this function cannot quietly redefine rules that
 * already have a trigger behind them.
 */
export async function heldCapacityAt(
  db: Database,
  actorId: number,
  capacity: LifecycleActorKind,
  at: Date,
): Promise<boolean> {
  const held = await grantsHeldAt(db, actorId, at);

  return held.some((grant) => grant.capacity === capacity);
}

/** Every grant an actor has ever held, revoked or not. For audit, never for authorisation. */
export async function grantHistory(db: Database, actorId: number) {
  return await db
    .select({
      grant: capacityGrant,
      revokedAt: capacityGrantRevocation.revokedAt,
      revocationReason: capacityGrantRevocation.reason,
    })
    .from(capacityGrant)
    .leftJoin(capacityGrantRevocation, eq(capacityGrantRevocation.grantId, capacityGrant.id))
    .where(eq(capacityGrant.actorId, actorId))
    .orderBy(sql`${capacityGrant.effectiveFrom} DESC`);
}
