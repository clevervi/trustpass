import {
  type Database,
  findLiveProductBySerial,
  findOrganizationByRegistration,
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
    readonly verificationStatus: schema.VerificationStatus;
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
  | { readonly ok: false; readonly reason: "issuer_not_found" }
  | {
      readonly ok: false;
      readonly reason: "duplicate_serial";
      /**
       * The identity this serial already holds. Returned so a client that timed
       * out and retried learns the identifier it already created, rather than
       * only being told no.
       */
      readonly existingTrustpassId: string;
    };

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
 * One issuer cannot hold two live identities for one serial. That is enforced
 * by a partial unique index rather than checked here, because two concurrent
 * retries would both pass an application check before either writes. This
 * translates the rejection into an outcome and reports which identity the
 * serial already belongs to.
 */
export async function registerProduct(
  db: Database,
  input: RegisterProductInput,
): Promise<RegisterProductResult> {
  const party = await findOrganizationByRegistration(
    db,
    input.issuer.country,
    input.issuer.registrationNumber,
  );

  if (!party) {
    return { ok: false, reason: "issuer_not_found" };
  }

  const inserted = await insertProduct(db, {
    trustpassId: generateTrustPassId(),
    organizationId: party.id,
    brand: input.brand,
    model: input.model,
    serial: input.serial,
    category: input.category,
    status: "registered",
  });

  if (!inserted.ok) {
    const existing = await findLiveProductBySerial(db, party.id, input.serial);

    return {
      ok: false,
      reason: "duplicate_serial",
      // The lookup can only miss if the winning row was retired between the
      // rejection and this read. Reporting the conflict without an identifier
      // is still the honest answer; inventing one would not be.
      existingTrustpassId: existing?.trustpassId ?? "unknown",
    };
  }

  const created = inserted.product;

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
        companyName: party.companyName,
        country: party.country,
        registrationNumber: party.registrationNumber,
        verificationStatus: party.verificationStatus,
      },
    },
  };
}
