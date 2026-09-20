import { and, eq, ne, sql } from "drizzle-orm";
import type { Database } from "../client.js";

/** The handle Drizzle hands a transaction callback. Not a `Database`. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

import type { TrustPassId } from "../identity/trustpass-id.js";
import { lifecycleEvent } from "../schema/lifecycle-event.js";
import { organization, type VerificationStatus } from "../schema/organization.js";
import {
  type NewProduct,
  type Product,
  type ProductCategory,
  type ProductOrigin,
  type ProductStatus,
  product,
} from "../schema/product.js";
import { UNIQUE_VIOLATION, violatedConstraint } from "./constraint-violation.js";
import type { RecordingActor } from "./enrolment-repository.js";

/** The partial unique index declared in `schema/product.ts`. */
const LIVE_SERIAL_INDEX = "product_live_organization_serial_idx";

/**
 * Thrown to unwind the transaction when authority is refused, and never seen by
 * a caller — `insertProduct` turns it back into an outcome.
 *
 * An outcome rather than an exception at the boundary, for the reason the rest
 * of this file gives: a refusal is an expected answer to a well-formed request
 * and modelling it as an error makes every caller wrap a normal branch in a try.
 */
class NotAuthorised extends Error {
  constructor() {
    super("The caller is not authorised to write this product.");
    this.name = "NotAuthorised";
  }
}

export type InsertProductResult =
  | { readonly ok: true; readonly product: Product }
  | { readonly ok: false; readonly reason: "duplicate_live_serial" }
  | { readonly ok: false; readonly reason: "not_authorised" };

/** What a caller decides, inside the transaction that will record the decision. */
export type Authorise = (
  tx: Transaction,
  /**
   * The transaction's own instant, and the same value the event will be
   * stamped with — `now()` is `transaction_timestamp()`, measured.
   */
  at: Date,
) => Promise<{ readonly grantId: number } | null>;

/**
 * Inserts a product, reporting a duplicate live serial as an outcome rather
 * than an exception.
 *
 * Only that one constraint is translated. Any other failure rethrows, because
 * swallowing an unrecognised database error would turn a real fault into a
 * plausible-looking rejection the caller would report to a user as their
 * mistake.
 *
 * Query construction stays inside this package on purpose. The API layer never
 * touches the query builder, which is what keeps ADR 0005's rule — the internal
 * key never crosses the API boundary — structural rather than a review habit.
 */
export async function insertProduct(
  db: Database,
  values: NewProduct,
  actor: Omit<RecordingActor, "grantId">,
  /**
   * Who says this write is allowed, decided **inside** this transaction.
   *
   * #174 measured what the alternative costs. Authorising on one connection and
   * writing on another leaves a window where a second session can revoke the
   * grant — or end the membership it is held through — between the two, and the
   * event that results names a grant that was already invalid at the instant
   * the event claims. A false row, in an append-only table, written by the path
   * whose whole purpose is provenance.
   *
   * A callback rather than a grant id, and rather than moving the rule in here.
   * Which capacity, over which organization, is `apps/api`'s decision and stays
   * there; what this package owns is that the decision and the record of it are
   * one act. Passing an id would put the lookup back outside the transaction
   * and change nothing.
   *
   * `at` is the transaction's instant and the same value `occurred_at` gets, so
   * "was this grant valid when the event says it happened" is true by
   * construction rather than by two clocks agreeing.
   */
  authorise: Authorise,
): Promise<InsertProductResult> {
  try {
    // One transaction, because a product and the record of where it came from
    // are one fact. If the event cannot be written the product must not exist:
    // a row with no provenance is exactly what ADR 0008's spine is for, and it
    // would be invisible — nothing later can tell that its history is missing
    // rather than empty.
    return await db.transaction(async (tx) => {
      // The transaction's own instant, read once and used twice: to decide
      // whether the authority held, and — as `now()` below — to stamp the event.
      // `now()` is `transaction_timestamp()`, so both are the same moment by
      // construction rather than by two clocks being close enough.
      //
      // `new Date(...)` at the boundary, because this comes back as a string.
      // The driver parses a `timestamptz` *column* into a `Date` and does not
      // do the same for an expression in a bare `execute`, so passing it
      // straight to `grantsHeldAt` reached Drizzle's timestamp mapper and threw
      // `value.toISOString is not a function`. The same shape as `bigint`
      // arriving as text: ask what the driver returns, not what the type says.
      const [instant] = await tx.execute<{ at: string }>(sql`SELECT now() AS at`);
      const at = new Date(instant?.at as string);

      const authority = await authorise(tx, at);

      if (!authority) {
        // Refused before anything is written, and thrown rather than returned.
        //
        // Not because committing an empty transaction costs anything — it does
        // not, today. Because of ordering: the day a statement is added above
        // this line, a `return` becomes a silent partial commit, and a sentinel
        // makes that impossible rather than merely unlikely. Defending it on
        // the harmless consequence is what invites somebody to simplify it back
        // in six months.
        throw new NotAuthorised();
      }

      const [created] = await tx.insert(product).values(values).returning();

      if (!created) {
        // A successful insert always returns its row. Reaching here means
        // something changed underneath us, not a case a caller can handle.
        throw new Error("Product insert returned no row.");
      }

      await tx.insert(lifecycleEvent).values({
        productId: created.id,
        // What actually happened, rather than one generic "created". A product
        // born `registered` is an issuer committing to the record; a `draft` is
        // a row that claims nothing yet, so saying it was registered would be a
        // claim nobody made.
        type: created.status === "registered" ? "product_registered" : "record_enrolled",
        // The capacity, not the person. A role an organization plays (ADR
        // 0012), and not the same thing as the party itself — still a literal,
        // still never read from a request.
        actorKind: "issuer",
        // The person, which TP-141 made nameable. It is the authenticated
        // principal and nothing else.
        actorId: actor.actorId,
        // **Which authority, not which capacity.** `actorKind` above says
        // `issuer`, and that is a claim about a role. ADR 0011 §3 asks for the
        // grant that authorised this specific act, and the difference is the one
        // this issue's title draws: naming an issuer is not being one, and
        // recording "an issuer did this" is not recording under what authority.
        //
        // It matters at the moment it is hardest to reconstruct. A grant is
        // revoked or expires, `grantsHeldAt` will never return it again, and
        // without this column the event says `issuer` while nothing can say
        // which grant was held — or whether one was.
        grantId: authority.grantId,
        organizationId: created.organizationId,
        // `now()` rather than the returned `created.createdAt`, and the
        // difference is not cosmetic. Postgres stores `timestamptz` to
        // microseconds; a JavaScript `Date` holds milliseconds, so passing the
        // value back through the client truncates it and the event lands up to
        // 999 microseconds before the row it describes.
        //
        // `now()` is the transaction timestamp and is constant for the whole
        // transaction, so this is the exact value the `created_at` default
        // already took — the same clock reading, never a second one.
        occurredAt: sql`now()`,
      });

      return { ok: true, product: created };
    });
  } catch (error) {
    if (error instanceof NotAuthorised) {
      return { ok: false, reason: "not_authorised" };
    }

    const violation = violatedConstraint(error);

    if (violation.code === UNIQUE_VIOLATION && violation.constraint === LIVE_SERIAL_INDEX) {
      return { ok: false, reason: "duplicate_live_serial" };
    }

    throw error;
  }
}

/**
 * Finds the live identity a party already holds for a serial.
 *
 * "Live" matches the partial unique index: every status except retired. Used to
 * tell a caller which TrustPass ID it collided with, which turns a duplicate
 * rejection into a recovery path for a client that timed out and retried.
 *
 * Serial comparison is lower-cased to match the index, or a lookup would miss
 * the very row that caused the conflict.
 */
export async function findLiveProductBySerial(
  db: Database,
  organizationId: number,
  serial: string,
): Promise<Product | undefined> {
  const [found] = await db
    .select()
    .from(product)
    .where(
      and(
        eq(product.organizationId, organizationId),
        sql`lower(${product.serial}) = lower(${serial})`,
        ne(product.status, "retired"),
      ),
    )
    .limit(1);

  return found;
}

/**
 * A product and the issuer that registered it, as stored.
 *
 * **Not safe to publish.** It carries the whole serial. Anything leaving the API
 * must project it first — mask the serial, compute the claims — and the name
 * says "record", not "passport", so nobody mistakes it for the public shape.
 *
 * What it does not carry matters as much: no `product.id`, no
 * `product.organizationId`, no `organization.id`. Per ADR 0005 those never cross the API
 * boundary, and the surest way to keep them from leaking is to never select
 * them.
 */
export interface ProductWithOrganization {
  readonly trustpassId: TrustPassId;
  readonly brand: string;
  readonly model: string;
  readonly serial: string;
  readonly category: ProductCategory;
  readonly status: ProductStatus;
  readonly origin: ProductOrigin;
  readonly createdAt: Date;
  /**
   * Null for a holder-enrolled record. Per ADR 0007 an individual is not an
   * issuer, so there is nothing to name — which is a different fact from an
   * issuer nobody has verified.
   */
  readonly issuer: {
    readonly companyName: string;
    readonly country: string;
    readonly registrationNumber: string;
    readonly verificationStatus: VerificationStatus;
  } | null;
}

/**
 * Finds a product by its public identifier, with its issuer, in one query.
 *
 * Takes the branded `TrustPassId` rather than a string, so an unparsed value
 * cannot reach Postgres. That forces the caller through `parseTrustPassId`
 * first — which is what lets it tell a mistyped identifier from an unknown one,
 * the distinction ADR 0004's check symbol exists to make.
 *
 * One join rather than two queries. The passport always needs both rows; and a
 * second query would need `product.organizationId` in hand, which puts an internal
 * key into a value that travels back up to the API. `organization_id` is not null
 * with a restricting foreign key, so an inner join cannot drop a row.
 *
 * The identifier is compared as-is, not lower-cased. `parseTrustPassId`
 * returns the canonical upper-case form, and wrapping the column in `lower()`
 * would stop `product_trustpass_id_idx` from being used.
 *
 * Returns whatever row exists, in any status. Deciding that a draft is not
 * publishable belongs to the caller: a repository that hides rows makes "not
 * found" ambiguous for every future caller.
 */
export async function findProductByTrustPassId(
  db: Database,
  trustpassId: TrustPassId,
): Promise<ProductWithOrganization | undefined> {
  const [found] = await db
    .select({
      trustpassId: product.trustpassId,
      brand: product.brand,
      model: product.model,
      serial: product.serial,
      category: product.category,
      status: product.status,
      origin: product.origin,
      createdAt: product.createdAt,
      issuer: {
        companyName: organization.companyName,
        country: organization.country,
        registrationNumber: organization.registrationNumber,
        verificationStatus: organization.verificationStatus,
      },
    })
    .from(product)
    // Left, not inner. An inner join drops a holder-enrolled record entirely,
    // which would report an existing product as not found — reaching the "we
    // could not check" failure by way of a join.
    .leftJoin(organization, eq(product.organizationId, organization.id))
    .where(eq(product.trustpassId, trustpassId))
    .limit(1);

  if (!found) return undefined;

  // Drizzle returns the nested object with every field null rather than a null
  // object, so the absence has to be recognised rather than assumed.
  return found.issuer?.companyName == null
    ? { ...found, issuer: null }
    : (found as ProductWithOrganization);
}
