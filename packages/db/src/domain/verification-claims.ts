import type { IssuerVerificationStatus } from "../schema/issuer.js";

/**
 * What a passport makes a statement about, in the order it should be read.
 *
 * The order is part of the contract, not a presentation detail: it is ADR 0003's
 * chain — issuer, then serial, then tag, then warranty — with physical
 * authenticity last, because it is the conclusion the other four do not reach.
 */
export const CLAIM_SUBJECTS = [
  "issuer",
  "serial",
  "secure_tag",
  "warranty",
  "physical_authenticity",
] as const;

export type ClaimSubject = (typeof CLAIM_SUBJECTS)[number];

/**
 * The states a claim can be in. Deliberately granular.
 *
 * Collapsing these is how a passport starts to lie. "We hold no warranty record"
 * and "this product has no secure tag" are different facts; "recorded" and
 * "verified" are the difference between an issuer's word and a check.
 */
export const CLAIM_STATES = [
  /** Checked against an authoritative source. */
  "verified",
  /** A check is in progress. */
  "pending",
  /** Nothing has been checked. */
  "unverified",
  /** Was trusted; trust withdrawn. */
  "suspended",
  /** On record, supplied by the issuer, never checked against the object. */
  "recorded",
  /** No such record exists in the system. */
  "not_recorded",
  /** The capability is absent for this product. */
  "not_present",
  /** No digital system can establish this. Permanent, not a gap to be closed. */
  "not_verifiable",
] as const;

export type ClaimState = (typeof CLAIM_STATES)[number];

export interface VerificationClaim {
  readonly claim: ClaimSubject;
  readonly state: ClaimState;
}

/**
 * An object rather than a bare status, so the secure-tag and warranty claims can
 * start reading real inputs later without every caller changing.
 */
export interface VerificationClaimsInput {
  /** Null when the record has no issuer at all — a holder enrolment. */
  readonly issuerVerificationStatus: IssuerVerificationStatus | null;
}

/**
 * `satisfies` rather than a cast: adding a fifth issuer status must fail to
 * compile here, not produce an `undefined` claim on a public page.
 */
const ISSUER_CLAIM_STATE = {
  unverified: "unverified",
  pending: "pending",
  verified: "verified",
  suspended: "suspended",
} as const satisfies Record<IssuerVerificationStatus, ClaimState>;

/**
 * States what TrustPass has actually checked, claim by claim.
 *
 * Per ADR 0003 this proves identity, never physical authenticity. If an issuer
 * registers a counterfeit as genuine, the system records that the issuer said
 * so; it has inspected nothing. So:
 *
 * - The serial is `recorded`, never `verified`. The issuer supplied it and
 *   nothing compared it to the object. That one word is the difference between
 *   this and a green checkmark.
 * - Physical authenticity is always `not_verifiable`. That is not a gap waiting
 *   for a feature; a ledger cannot inspect an object.
 *
 * There is deliberately no aggregate verdict. A caller that wants one has to
 * build it, and should have to explain why.
 *
 * Product status is not an input. A suspended product is a fact about the unit,
 * not about what was checked, and it is surfaced as such by the passport.
 */
export function computeVerificationClaims(
  input: VerificationClaimsInput,
): readonly VerificationClaim[] {
  return [
    {
      claim: "issuer",
      // `not_present` rather than `unverified`, and the difference is the whole
      // point: "nobody has checked this company" and "there is no company" are
      // different facts, and reporting the second as the first invents an
      // issuer the record does not have.
      state:
        input.issuerVerificationStatus === null
          ? "not_present"
          : ISSUER_CLAIM_STATE[input.issuerVerificationStatus],
    },
    { claim: "serial", state: "recorded" },
    { claim: "secure_tag", state: "not_present" },
    { claim: "warranty", state: "not_recorded" },
    { claim: "physical_authenticity", state: "not_verifiable" },
  ];
}
