import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { credential } from "../schema/credential.js";
import { digestOf, digestsMatch, type Environment, parseToken } from "./credential-token.js";

/**
 * Who is making the request, and nothing about what they may do.
 *
 * ADR 0014 §5. A principal carrying `canEnrol` would be role-based access
 * control wearing a different name, and TrustPass already has an authority
 * model that is better than one: grants pinned to the moment they were used.
 * Authorisation is a separate lookup and it runs afterwards.
 */
export interface AuthenticatedPrincipal {
  readonly actorId: number;
  readonly credentialId: number;
}

/**
 * The smallest surface this needs, so a transaction is as acceptable as a pool.
 *
 * Typing the parameter as `Database` would exclude the one caller that most
 * needs it: the test that writes `expires_at = now()` and verifies inside the
 * same transaction, which is the only place where `>` and `>=` are actually
 * distinguishable.
 */
type Reader = Pick<Database, "select">;

/**
 * A digest that matches nothing, generated once per process.
 *
 * When no row is found there is nothing to compare against, and returning early
 * would make "unknown handle" cheaper than "wrong secret" by one SHA-256
 * comparison. Comparing against this instead keeps the work the same shape.
 *
 * It equalises that one step and is not a claim that the whole path is
 * constant-time — the database round trip dominates, and a lookup that misses
 * an index is a far larger signal than a digest comparison. What ADR 0014 §7
 * requires is that the *answer* is identical, and that is enforced by the
 * single return below.
 */
const NEVER_MATCHES = randomBytes(32);

/**
 * Resolves a presented credential to the actor it belongs to, or to nothing.
 *
 * Absent, malformed, unknown, expired, revoked, the wrong environment and the
 * wrong secret all produce `null`. A caller learning which of those applied
 * would learn whether a credential exists — the same oracle #143 removed from
 * `/enrolments`, and there is no reason to reintroduce it at the door.
 *
 * State is decided by the database clock, not this process's. `expires_at` is
 * compared against `now()` in the query rather than a `Date` sent from Node,
 * because a skewed application server would otherwise change who authenticates,
 * and the database is the one clock every deployment shares.
 */
export async function verifyCredential(
  db: Reader,
  presented: string | undefined,
  environment: Environment,
): Promise<AuthenticatedPrincipal | null> {
  const parsed = parseToken(presented, environment);

  // Before any query, deliberately. A token for another environment is not a
  // credential here, and looking it up would turn "this is a staging token"
  // into something the database has been asked about.
  if (parsed === null) {
    return null;
  }

  const [found] = await db
    .select({
      id: credential.id,
      actorId: credential.actorId,
      secretDigest: credential.secretDigest,
    })
    .from(credential)
    .where(
      and(
        eq(credential.handle, parsed.handle),
        // A revocation is a fact that it happened, not a time it takes effect.
        // Comparing it to `now()` would be a scheduled revocation, which is a
        // different feature nobody asked for — ADR 0014 §2.
        isNull(credential.revokedAt),
        // `>` and not `>=`: a credential expiring exactly now is expired.
        or(isNull(credential.expiresAt), gt(credential.expiresAt, sql`now()`)),
      ),
    )
    .limit(1);

  const matched = digestsMatch(digestOf(parsed.secret), found?.secretDigest ?? NEVER_MATCHES);

  // `found` is re-checked rather than inferred from `matched`. A credential
  // that predates this feature has a null digest, and `?? NEVER_MATCHES` makes
  // that row compare against a value it cannot equal — but relying on that
  // alone would make the guarantee depend on a random number rather than on a
  // row being present.
  return matched && found !== undefined ? { actorId: found.actorId, credentialId: found.id } : null;
}
