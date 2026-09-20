import type { Database } from "../client.js";
import type { LifecycleActorKind } from "../schema/actor-capacity.js";
import { capacityGrant } from "../schema/capacity-grant.js";
import { membership } from "../schema/membership.js";

/**
 * Gives a test actor the authority a write now requires.
 *
 * Before #152 a test could register a product by naming any organization, and
 * every fixture did. The check that ended that also ended those fixtures, which
 * is the intended shape: a test that registers a product has to say under whose
 * authority, because the endpoint now asks.
 *
 * Both rows, and both with lifetimes, because one without the other authorises
 * nothing. Per ADR 0011 §2 a grant held through an organization applies only
 * while a membership covers the moment — so a helper that wrote the grant alone
 * would produce fixtures that fail for a reason the test did not intend and
 * that reads like the check is broken.
 */
export async function grantAuthorityOver(
  db: Database,
  actorId: number,
  organizationId: number,
  capacity: LifecycleActorKind = "issuer",
): Promise<number> {
  const aDayAgo = new Date(Date.now() - 24 * 3_600_000);

  await db.insert(membership).values({
    actorId,
    organizationId,
    beganAt: aDayAgo,
    // Open-ended. A test that wants a membership that ended says so itself —
    // that case is the boundary between authentication and authority, and it
    // should not arrive by default from a helper.
    endedAt: null,
  });

  // Returns the grant's id, because #152 made that the thing an issuer write
  // has to record. A fixture that only established authority could not build a
  // `RecordingActor`, and a test that made one up would be naming a grant that
  // authorised nothing.
  const [granted] = await db
    .insert(capacityGrant)
    .values({
      actorId,
      organizationId,
      capacity,
      scopeKind: "own_organization",
      effectiveFrom: aDayAgo,
      expiresAt: null,
    })
    .returning({ id: capacityGrant.id });

  return granted?.id as number;
}
