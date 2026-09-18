import { and, eq, exists, gt, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import type { LifecycleActorKind } from "../schema/actor-capacity.js";
import { capacityGrant, capacityGrantRevocation } from "../schema/capacity-grant.js";
import { membership } from "../schema/membership.js";

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
 *
 * **A grant held through an organization also needs a membership covering that
 * instant.** Per ADR 0011 §2 as amended: a grant with an `organization_id` is
 * authority on behalf of that party, and the relationship is what makes it that.
 * Without this the query answered a question nobody asked — an employee who left
 * in June still held the organization's capacity in July, and kept it until the
 * grant expired nineteen months later.
 *
 * A grant with no organization — a `system` capacity — needs no membership, so
 * the condition is `organization_id IS NULL OR a membership covers it` rather
 * than a join that would silently drop every system grant.
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
        // And the relationship the grant is held through, where there is one.
        //
        // Written with Drizzle's `exists` rather than a raw fragment: a raw one
        // takes the instant as an untyped parameter and postgres.js is handed a
        // Date where it expects a string. Measured — the first version of this
        // failed every query in the suite with ERR_INVALID_ARG_TYPE.
        or(
          isNull(capacityGrant.organizationId),
          exists(
            db
              .select({ present: sql`1` })
              .from(membership)
              .where(
                and(
                  eq(membership.actorId, capacityGrant.actorId),
                  eq(membership.organizationId, capacityGrant.organizationId),
                  lte(membership.beganAt, at),
                  or(isNull(membership.endedAt), gt(membership.endedAt, at)),
                ),
              ),
          ),
        ),
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
