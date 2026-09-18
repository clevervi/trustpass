import { and, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { type Organization, organization } from "../schema/organization.js";

/**
 * Finds a party by the identity the outside world can name it with.
 *
 * Per ADR 0006 that is the registration number its national authority
 * guarantees unique, scoped by country — a legal name is not an identifier,
 * because two companies share one and one company changes its own. Per ADR 0005
 * the internal key is never a valid lookup key from outside, which is why there
 * is no `findById` here.
 *
 * This replaces `findIssuerByRegistration`. Per ADR 0012 an organization is the
 * canonical identity of a party and `issuer` is a role it plays, so looking a
 * party up by its registry identity is not an issuer question — it is the same
 * question it always was, asked of the table that will still exist next week.
 */
export async function findOrganizationByRegistration(
  db: Database,
  country: string,
  registrationNumber: string,
): Promise<Organization | undefined> {
  const [found] = await db
    .select()
    .from(organization)
    .where(
      and(
        eq(organization.country, country),
        eq(organization.registrationNumber, registrationNumber),
      ),
    )
    .limit(1);

  return found;
}
