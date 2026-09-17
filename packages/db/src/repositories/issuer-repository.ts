import { and, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { type Issuer, issuer } from "../schema/issuer.js";

/**
 * Finds an issuer by the identity the outside world can name it with.
 *
 * Per ADR 0006 that is the registration number its national authority
 * guarantees unique, scoped by country. Per ADR 0005 the internal key is never
 * a valid lookup key from outside, which is why there is no `findById` here.
 */
export async function findIssuerByRegistration(
  db: Database,
  country: string,
  registrationNumber: string,
): Promise<Issuer | undefined> {
  const [found] = await db
    .select()
    .from(issuer)
    .where(and(eq(issuer.country, country), eq(issuer.registrationNumber, registrationNumber)))
    .limit(1);

  return found;
}
