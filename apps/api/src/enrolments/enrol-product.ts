import {
  type AuthenticatedPrincipal,
  type Database,
  enrolProduct as enrolInDatabase,
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
    };

/*
 * What used to be here: `existingTrustpassId`, returned so a client that timed
 * out and retried learned the identifier it had already created.
 *
 * A good reason, and it made a serial printed on the outside of an object into
 * a lookup key for the identifier ADR 0004 spent its entire Context keeping
 * unguessable. Anyone holding a photograph of a label could ask for the
 * passport identity of the thing in it.
 *
 * The retry it existed for comes back under #141, and not as "you are
 * authenticated, here is the identifier" — being the same actor does not prove
 * this actor created that enrolment. It needs proof of entitlement to that
 * enrolment: a key its creator holds, or a credential issued when it was made.
 */

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
  principal: AuthenticatedPrincipal,
): Promise<EnrolProductResult> {
  const result = await enrolInDatabase(
    db,
    {
      trustpassId: generateTrustPassId(),
      brand: input.brand,
      model: input.model,
      serial: input.serial,
      category: input.category,
    },
    // Two arguments, and the separation is the point: the first is what the
    // caller described, the second is who the caller is. Nothing crosses.
    //
    // `grantId: null` is an answer, not an omission. Enrolling a product is
    // something anybody holding one may do on their own behalf — there is no
    // organization, no capacity was claimed, and no grant authorised it. The
    // field is required on `RecordingActor` so that this had to be said rather
    // than defaulted, because the same null on an issuer event means something
    // was lost. See #152.
    { actorId: principal.actorId, grantId: null },
  );

  if (!result.ok) {
    // No second lookup. It existed only to name the identifier, and a query
    // that produces nothing a caller may see is a query that should not run.
    return { ok: false, reason: "duplicate_serial" };
  }

  const { trustpassId, brand, model, serial, category, status, origin, createdAt } = result.product;

  return {
    ok: true,
    product: { trustpassId, brand, model, serial, category, status, origin, createdAt },
  };
}
