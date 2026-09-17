import {
  type Database,
  findIssuerByRegistration,
  generateTrustPassId,
  insertProduct,
  type schema,
} from "@trustpass/db";

export interface RegisterProductInput {
  /**
   * The issuer, named the way the outside world can name it.
   *
   * Not the internal key: per ADR 0005 that never crosses the API boundary, and
   * per ADR 0006 an issuer's public identity is the registration number its own
   * national authority guarantees unique.
   */
  readonly issuer: {
    readonly country: string;
    readonly registrationNumber: string;
  };
  readonly brand: string;
  readonly model: string;
  readonly serial: string;
  readonly category: schema.ProductCategory;
}

/** What a caller is allowed to see back. Deliberately excludes the internal key. */
export interface RegisteredProduct {
  readonly trustpassId: string;
  readonly brand: string;
  readonly model: string;
  readonly serial: string;
  readonly category: schema.ProductCategory;
  readonly status: schema.ProductStatus;
  readonly createdAt: Date;
  readonly issuer: {
    readonly companyName: string;
    readonly country: string;
    readonly registrationNumber: string;
    readonly verificationStatus: schema.IssuerVerificationStatus;
  };
}

/**
 * Outcomes the HTTP layer has to distinguish.
 *
 * A union rather than a thrown error: "this issuer does not exist" is an
 * expected answer to a well-formed request, not an exception, and modelling it
 * as one makes the route read like a normal branch.
 */
export type RegisterProductResult =
  | { readonly ok: true; readonly product: RegisteredProduct }
  | { readonly ok: false; readonly reason: "issuer_not_found" };

/**
 * Registers a product against an existing issuer.
 *
 * The TrustPass ID is generated here and never read from the request. A caller
 * that could choose its own identifier could collide with one already printed
 * on a label, or pick a value it had seen elsewhere.
 *
 * Products are created `registered` rather than `draft`: calling this endpoint
 * is the issuer committing to the record. `draft` exists for rows that arrive
 * some other way, such as a bulk import staged before review.
 *
 * Known gap until TP-024: nothing here stops the same issuer registering the
 * same serial twice. A client retrying after a timeout will produce a second
 * identity for one physical product, which is the failure a passport exists to
 * prevent. The fix belongs in the database, because two concurrent retries both
 * pass an application-level check before either writes.
 */
export async function registerProduct(
  db: Database,
  input: RegisterProductInput,
): Promise<RegisterProductResult> {
  const issuer = await findIssuerByRegistration(
    db,
    input.issuer.country,
    input.issuer.registrationNumber,
  );

  if (!issuer) {
    return { ok: false, reason: "issuer_not_found" };
  }

  const created = await insertProduct(db, {
    trustpassId: generateTrustPassId(),
    issuerId: issuer.id,
    brand: input.brand,
    model: input.model,
    serial: input.serial,
    category: input.category,
    status: "registered",
  });

  return {
    ok: true,
    product: {
      trustpassId: created.trustpassId,
      brand: created.brand,
      model: created.model,
      serial: created.serial,
      category: created.category,
      status: created.status,
      createdAt: created.createdAt,
      issuer: {
        companyName: issuer.companyName,
        country: issuer.country,
        registrationNumber: issuer.registrationNumber,
        verificationStatus: issuer.verificationStatus,
      },
    },
  };
}
