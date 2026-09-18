import {
  type Database,
  enrolProduct as enrolInDatabase,
  findLiveHolderEnrolment,
  generateTrustPassId,
  type schema,
} from "@trustpass/db";

/**
 * What a person enrolling a product they hold may state.
 *
 * No issuer, and not because it is optional: an enrolment is made by somebody
 * with no company behind them, and accepting one here would let a caller claim
 * a standing this path cannot check.
 */
export interface EnrolProductInput {
  readonly brand: string;
  readonly model: string;
  readonly serial: string;
  readonly category: schema.ProductCategory;
}

/** What a caller is allowed to see back. No internal key — ADR 0005. */
export interface EnrolledProduct {
  readonly trustpassId: string;
  readonly brand: string;
  readonly model: string;
  readonly serial: string;
  readonly category: schema.ProductCategory;
  readonly status: schema.ProductStatus;
  readonly origin: schema.ProductOrigin;
  readonly createdAt: Date;
}

export type EnrolProductResult =
  | { readonly ok: true; readonly product: EnrolledProduct }
  | {
      readonly ok: false;
      readonly reason: "duplicate_serial";
      /**
       * The enrolment this serial already has. Returned so a client that timed
       * out and retried learns the identifier it already created, rather than
       * being told to try again with something different.
       */
      readonly existingTrustpassId: string | null;
    };

/**
 * Enrols a product nobody registered.
 *
 * What this records is narrow and the whole path is shaped to keep it that way:
 * **somebody entered this serial.** Not that they own the product, not that the
 * product is genuine, and not that anything about it has been checked. Per ADR
 * 0007 what begins here is TrustPass's record, not the product — the object is
 * older than the row.
 */
export async function enrolProduct(
  db: Database,
  input: EnrolProductInput,
): Promise<EnrolProductResult> {
  const result = await enrolInDatabase(db, {
    trustpassId: generateTrustPassId(),
    brand: input.brand,
    model: input.model,
    serial: input.serial,
    category: input.category,
  });

  if (!result.ok) {
    const existing = await findLiveHolderEnrolment(db, input.serial);

    return {
      ok: false,
      reason: "duplicate_serial",
      // Null rather than a throw: the row can be retired between the failed
      // insert and this lookup, and a caller learning "already enrolled" with
      // no identifier is still better served than one getting a 500.
      existingTrustpassId: existing?.trustpassId ?? null,
    };
  }

  const { trustpassId, brand, model, serial, category, status, origin, createdAt } = result.product;

  return {
    ok: true,
    product: { trustpassId, brand, model, serial, category, status, origin, createdAt },
  };
}
