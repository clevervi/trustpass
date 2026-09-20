import {
  type AuthenticatedPrincipal,
  type Database,
  findOrganizationByRegistration,
  generateTrustPassId,
  grantsHeldAt,
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
  | { readonly ok: false; readonly reason: "not_authorised_for_issuer" }
  | {
      readonly ok: false;
      readonly reason: "duplicate_serial";
    };

/*
 * `existingTrustpassId` used to be here too, for the same reason and with the
 * same consequence: a serial is printed on the object, so returning the
 * identity it already holds turns a photograph of a label into a passport
 * lookup. Removed with the one in enrol-product.ts — fixing one endpoint and
 * leaving its sibling is how a defect comes back wearing a different name.
 */

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
  principal: AuthenticatedPrincipal,
): Promise<RegisterProductResult> {
  const party = await findOrganizationByRegistration(
    db,
    input.issuer.country,
    input.issuer.registrationNumber,
  );

  if (!party) {
    return { ok: false, reason: "issuer_not_found" };
  }

  // **Naming an issuer is not being one.**
  //
  // A registration number is public — national registries publish them and
  // `apps/web` prints one on every passport, which is ADR 0003's argument — so
  // until here, an authenticated caller could register under any organization
  // in the database by naming it.
  //
  // `grantsHeldAt` returns what this actor holds at this instant, already
  // filtered by the grant's own lifetime, its revocation, and a membership
  // covering the moment (ADR 0011 §2). It does not authorise anything by
  // itself: matching the organization and the capacity is this caller's work,
  // and keeping it here is what leaves that function answering the other
  // questions it will be asked.
  //
  // The capacity is `issuer` specifically, because `insertProduct` writes
  // `actorKind: "issuer"` as a literal — so the event this produces *claims*
  // that capacity. Accepting any grant would let an actor holding only
  // `authority` produce a record saying `issuer`, which nobody granted.
  // Authorise the claim the record will make, not a weaker one.
  // `find`, not `some`. The grant that authorises this write is the grant the
  // event has to name, per ADR 0011 §3, and a boolean throws away the only
  // thing that can answer "under what authority" once the grant is revoked.
  // Asking twice — once to decide, once to record — would be asking at two
  // different instants and could disagree.
  //
  // **And this instant is not the one the event claims.** `new Date()` is this
  // process's clock; `insertProduct` stamps `occurred_at` with the database's
  // `now()`, inside a transaction this lookup has already returned from. A
  // grant revoked in that window produces an event whose `occurred_at` is later
  // than the moment its own `grant_id` stopped being valid. Naming the grant is
  // what turned that from an invisible stale read into a claim in the record,
  // so it is #174 rather than a comment nobody filed.
  const held = await grantsHeldAt(db, principal.actorId, new Date());
  const authorising = held.find(
    (grant) => grant.capacity === "issuer" && grant.organizationId === party.id,
  );

  if (!authorising) {
    return { ok: false, reason: "not_authorised_for_issuer" };
  }

  const inserted = await insertProduct(
    db,
    {
      trustpassId: generateTrustPassId(),
      // From the body, by lookup, and now proof of a relationship: the grant
      // found above is over this organization, so a caller can no longer name
      // one it has nothing to do with.
      organizationId: party.id,
      brand: input.brand,
      model: input.model,
      serial: input.serial,
      category: input.category,
      status: "registered",
    },
    // From the credential and from the grant that authorised this write, and
    // from nowhere else. Neither value can come from the request body.
    { actorId: principal.actorId, grantId: authorising.id },
  );

  if (!inserted.ok) {
    return { ok: false, reason: "duplicate_serial" };
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
