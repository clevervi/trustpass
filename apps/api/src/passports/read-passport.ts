import {
  type ClaimState,
  type ClaimSubject,
  computeVerificationClaims,
  type Database,
  discloseSerial,
  findProductByTrustPassId,
  type schema,
  type TrustPassId,
} from "@trustpass/db";

/** A status a published passport can be in. A draft is never published. */
export type PublishedStatus = Exclude<schema.ProductStatus, "draft">;

/**
 * The public shape of a passport — everything a stranger holding a QR may see.
 *
 * The whole serial is not a field. That is the type-level guarantee behind the
 * masking: a route cannot return what this shape does not contain.
 */
export interface PublicPassport {
  readonly trustpassId: string;
  readonly brand: string;
  readonly model: string;
  readonly category: schema.ProductCategory;
  readonly status: PublishedStatus;
  /** The last four characters and how many are withheld, or null when none can be shown safely. */
  readonly serial: { readonly suffix: string; readonly hiddenCharacters: number } | null;
  /**
   * The registration date, not the instant. A buyer needs the day — a passport
   * created yesterday for a two-year-old product is a signal. The millisecond
   * would republish issuance order and rate, which ADR 0004 kept out of the
   * identifier for exactly that reason.
   */
  readonly registeredOn: string;
  readonly issuer: {
    readonly companyName: string;
    readonly country: string;
    readonly registrationNumber: string;
    readonly verificationStatus: schema.IssuerVerificationStatus;
  };
  readonly claims: readonly { readonly claim: ClaimSubject; readonly state: ClaimState }[];
}

export type ReadPassportResult =
  | { readonly ok: true; readonly passport: PublicPassport }
  | { readonly ok: false; readonly reason: "not_found" };

/**
 * Reads a product's public passport.
 *
 * Takes an identifier that has already been parsed, so the check-symbol decision
 * — mistyped versus unknown — is made before anything reaches the database.
 *
 * A draft is reported as not found. A draft is a row that claims nothing;
 * publishing its passport would publish a claim nobody made. A distinct error
 * would also confirm the identifier is allocated, which a stranger has no
 * business learning.
 */
export async function readPassport(
  db: Database,
  trustpassId: TrustPassId,
): Promise<ReadPassportResult> {
  const record = await findProductByTrustPassId(db, trustpassId);

  if (!record || record.status === "draft") {
    return { ok: false, reason: "not_found" };
  }

  const disclosure = discloseSerial(record.serial);

  return {
    ok: true,
    passport: {
      trustpassId: record.trustpassId,
      brand: record.brand,
      model: record.model,
      category: record.category,
      status: record.status,
      serial: disclosure.disclosed
        ? { suffix: disclosure.suffix, hiddenCharacters: disclosure.hiddenCharacters }
        : null,
      registeredOn: record.createdAt.toISOString().slice(0, 10),
      issuer: record.issuer,
      claims: computeVerificationClaims({
        issuerVerificationStatus: record.issuer.verificationStatus,
      }),
    },
  };
}
