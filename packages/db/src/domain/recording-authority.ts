import type { LifecycleActorKind, LifecycleEventType } from "../schema/lifecycle-event.js";
import type { ProductStatus } from "../schema/product.js";

/**
 * What each capacity is allowed to record.
 *
 * Authentication decides *who* somebody is; that is TP-141 and does not exist.
 * This decides what a claimed capacity may assert, which is a different question
 * and answerable now — and urgent since `POST /enrolments` shipped, because
 * anyone can put a record into the system and nothing constrained what could
 * then be recorded against it.
 *
 * The entry that matters most is the one that is absent: **a holder cannot
 * reinstate.** A product suspended over a theft report, cleared by the person
 * holding it, is the system helping launder a stolen device. Whoever can
 * investigate a report is who can close it.
 *
 * Declared here and mirrored by a database trigger, for the reason the status
 * transitions are: a rule that lives only in TypeScript is bypassed by the first
 * path that writes without going through it. The integration suite compares the
 * two and fails if they ever disagree.
 */
export const RECORDING_AUTHORITY: Readonly<
  Record<LifecycleActorKind, readonly LifecycleEventType[]>
> = {
  /**
   * Somebody who says they have the object.
   *
   * They can say "I put this into TrustPass" and "this has reached the end of
   * its life". They cannot register on a business's behalf, and they cannot
   * clear an accusation made against the thing they hold.
   */
  holder: ["record_enrolled", "product_retired"],

  /**
   * A registered business.
   *
   * Its own registration, and retiring what it registered. Suspension is not
   * here: an issuer suspending a product to bury a complaint about it is the
   * same conflict of interest as a holder clearing one.
   */
  issuer: ["record_enrolled", "product_registered", "product_retired"],

  /**
   * A police report, a customs seizure, a regulator.
   *
   * A report and its resolution belong together: whoever can raise one is who
   * can close it, and splitting them would leave suspensions nobody could lift.
   */
  authority: ["product_suspended", "product_reinstated", "product_retired"],

  /** TrustPass itself. Only the system corrects the system's own record. */
  system: ["record_corrected"],
} as const;

export class UnauthorisedRecording extends Error {
  constructor(
    readonly actorKind: LifecycleActorKind,
    readonly type: LifecycleEventType,
  ) {
    super(`A ${actorKind} cannot record "${type}".`);
    this.name = "UnauthorisedRecording";
  }
}

/**
 * Whether this capacity may end the life of a product in this state.
 *
 * Retiring a product frees its serial — the live-serial index excludes retired
 * rows on purpose, so a warranty replacement can reuse the serial of the unit it
 * replaces. That is correct, and combined with a holder being able to retire it
 * became a door: suspend over a theft report, retire, re-enrol the serial, and
 * the new passport has no history.
 *
 * So whoever can investigate a report is who can decide the object's life ends
 * while that report is open. Everything else is untouched.
 */
export function mayRetireFrom(actorKind: LifecycleActorKind, from: ProductStatus): boolean {
  return from === "suspended" ? actorKind === "authority" : true;
}

/** Whether this capacity may record this kind of event. */
export function mayRecord(actorKind: LifecycleActorKind, type: LifecycleEventType): boolean {
  return RECORDING_AUTHORITY[actorKind].includes(type);
}

/** Every pairing, for tests that compare this table against the database trigger. */
export function recordingAuthorityPairs(): readonly {
  actorKind: LifecycleActorKind;
  type: LifecycleEventType;
}[] {
  return Object.entries(RECORDING_AUTHORITY).flatMap(([actorKind, types]) =>
    types.map((type) => ({ actorKind: actorKind as LifecycleActorKind, type })),
  );
}
