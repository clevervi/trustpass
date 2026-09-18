import {
  type ClaimState,
  type ClaimSubject,
  computeVerificationClaims,
  type Database,
  discloseSerial,
  findHistoryByTrustPassId,
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
  /**
   * What has been recorded about this product, newest first.
   *
   * Per ADR 0008 these are assertions that something happened, not established
   * facts, and nothing here may be presented as a conclusion. `theft_report` is
   * a report somebody filed; it is not the statement that a product was stolen.
   *
   * Empty for a product whose record predates lifecycle events. An empty
   * history is not a clean one — it means nothing was recorded, which is a
   * different thing from nothing having happened.
   */
  readonly history: readonly PassportHistoryEntry[];
}

/** One recorded assertion, as a stranger holding a QR may see it. */
export interface PassportHistoryEntry {
  readonly type: schema.LifecycleEventType;
  /** The capacity somebody acted in. Never a name — identifying a person is TP-141. */
  readonly actorKind: schema.LifecycleActorKind;
  /** When it is reported to have happened, as a date. */
  readonly occurredOn: string;
  /**
   * When TrustPass recorded it, as a date.
   *
   * Sent even when it equals `occurredOn`, so the page decides what to show
   * rather than inferring a gap from a missing field.
   */
  readonly recordedOn: string;
  readonly reason: schema.LifecycleEventReason | null;
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
  const history = await findHistoryByTrustPassId(db, trustpassId);

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
      // Dates, not instants, for the reason `registeredOn` is one: a
      // millisecond republishes ordering and rate, and a reader needs the day.
      history: history.map((entry) => ({
        type: entry.type,
        actorKind: entry.actorKind,
        occurredOn: entry.occurredAt.toISOString().slice(0, 10),
        recordedOn: entry.recordedAt.toISOString().slice(0, 10),
        reason: entry.reason,
      })),
    },
  };
}
