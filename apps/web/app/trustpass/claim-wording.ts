/**
 * The words a passport uses. The API sends codes; this is the only place they
 * become language.
 *
 * Every string here is a claim made to a stranger deciding whether to trust a
 * product. Per ADR 0003 none of them may imply physical authenticity, none may
 * turn "recorded" into "verified", and nothing may be louder than what was
 * actually checked.
 */

export type Tone = "positive" | "neutral" | "caution" | "negative";

export interface ClaimWording {
  readonly subject: string;
  readonly label: string;
  readonly tone: Tone;
  readonly detail: string;
}

const SUBJECTS: Readonly<Record<string, string>> = {
  issuer: "Issuer",
  serial: "Serial number",
  secure_tag: "Secure tag",
  warranty: "Warranty",
  physical_authenticity: "Physical product",
};

const STATES: Readonly<Record<string, { readonly label: string; readonly tone: Tone }>> = {
  verified: { label: "Verified", tone: "positive" },
  pending: { label: "Check in progress", tone: "neutral" },
  unverified: { label: "Not verified", tone: "caution" },
  suspended: { label: "Trust withdrawn", tone: "negative" },
  recorded: { label: "Recorded, not checked", tone: "neutral" },
  not_recorded: { label: "Nothing on record", tone: "neutral" },
  not_present: { label: "None", tone: "neutral" },
  not_verifiable: { label: "Not independently verified", tone: "neutral" },
};

/** Keyed by `claim:state`. A combination with no entry falls back to the state's label alone. */
const DETAILS: Readonly<Record<string, string>> = {
  "issuer:verified":
    "TrustPass has confirmed this company exists in its national business registry. That is a check of the company, not of this product.",
  "issuer:pending": "TrustPass is checking this company against its national registry.",
  "issuer:unverified": "Nobody has checked this company. Everything on this page is its own word.",
  "issuer:suspended":
    "TrustPass has withdrawn its trust in this company. Treat what it registered with caution.",
  "serial:recorded":
    "The issuer supplied this serial. Nothing has compared it to the object in front of you — compare the last characters with the label yourself.",
  "secure_tag:not_present":
    "This product has no cryptographic tag. A QR code can be copied onto any object, so it proves only that someone had the code.",
  "warranty:not_recorded": "No warranty has been recorded for this product.",
  "physical_authenticity:not_verifiable":
    "TrustPass has not inspected this object and cannot. It records who made each claim about a product, not whether the object is genuine.",
};

const UNKNOWN_STATE = { label: "Not described", tone: "neutral" } as const;

function humanise(code: string): string {
  const spaced = code.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Words for one claim.
 *
 * An unknown state — the API added one before this page learned it — renders as
 * neutral and undescribed. Never as positive: a state this page does not
 * understand is not evidence of anything.
 */
export function describeClaim(claim: string, state: string): ClaimWording {
  const known = STATES[state] ?? UNKNOWN_STATE;

  return {
    subject: SUBJECTS[claim] ?? humanise(claim),
    label: known.label,
    tone: known.tone,
    detail: DETAILS[`${claim}:${state}`] ?? "",
  };
}

const CATEGORIES: Readonly<Record<string, string>> = {
  gpu: "Graphics card",
  cpu: "Processor",
  motherboard: "Motherboard",
  laptop: "Laptop",
  desktop: "Desktop computer",
  smartphone: "Smartphone",
  tablet: "Tablet",
  monitor: "Monitor",
  camera: "Camera",
  console: "Games console",
  storage: "Storage device",
  peripheral: "Peripheral",
  other: "Other",
};

export function describeCategory(category: string): string {
  return CATEGORIES[category] ?? humanise(category);
}

const STATUSES: Readonly<Record<string, { readonly label: string; readonly tone: Tone }>> = {
  registered: { label: "Registered", tone: "neutral" },
  active: { label: "Active", tone: "neutral" },
  suspended: { label: "Suspended", tone: "negative" },
  retired: { label: "Retired", tone: "caution" },
};

export function describeStatus(status: string): { readonly label: string; readonly tone: Tone } {
  return STATUSES[status] ?? { label: humanise(status), tone: "neutral" };
}

/**
 * The words a history entry uses.
 *
 * Every string here describes **something somebody reported**, never something
 * TrustPass established. Per ADR 0008 an event records that an actor reported
 * or caused a change; it does not prove the change occurred in the world.
 *
 * That distinction is the whole risk of this section. `product_suspended` with
 * reason `theft_report` may read "a theft report was recorded". It may never
 * read "stolen" — the first says who filed what, the second accuses a seller on
 * the strength of one unverified report, which is ADR 0003's failure reached
 * through a history instead of a badge.
 */

const EVENT_TITLES: Readonly<Record<string, string>> = {
  record_enrolled: "Record began",
  product_registered: "Registered with TrustPass",
  product_suspended: "Suspended",
  product_reinstated: "Suspension lifted",
  product_retired: "Retired",
  record_corrected: "An earlier entry was corrected",
};

/**
 * Reasons, worded as reports rather than findings.
 *
 * Read each one and ask whether it could be mistaken for a conclusion. "Theft
 * reported" cannot; "Stolen" could.
 */
const EVENT_REASONS: Readonly<Record<string, string>> = {
  theft_report: "a theft was reported",
  fraud_flag: "a fraud concern was raised",
  counterfeit_report: "a counterfeit concern was reported",
  ownership_dispute: "ownership was disputed",
  warranty_dispute: "a warranty claim was disputed",
  investigation_closed: "an investigation was closed",
  dispute_resolved: "a dispute was resolved",
  issuer_request: "the issuer asked for it",
  holder_request: "the holder asked for it",
  warranty_replacement: "it was replaced under warranty",
  end_of_life: "it reached the end of its registered life",
  recording_error: "the earlier entry was recorded in error",
};

/** In what capacity somebody acted. Never who they are — that needs TP-141. */
const ACTOR_CAPACITIES: Readonly<Record<string, string>> = {
  issuer: "the issuer",
  holder: "whoever held the product",
  authority: "an authority",
  system: "TrustPass",
};

export interface HistoryWording {
  readonly title: string;
  /** The reason as a clause, or empty. Never a verdict. */
  readonly because: string;
  readonly actor: string;
  readonly tone: Tone;
}

/**
 * Words for one history entry.
 *
 * An unrecognised type or reason is humanised and rendered neutrally. It is
 * never rendered as worse or better than what is known, because a state this
 * page does not understand is not evidence in either direction.
 */
export function describeHistoryEntry(
  type: string,
  reason: string | null,
  actorKind: string,
): HistoryWording {
  return {
    title: EVENT_TITLES[type] ?? humanise(type),
    because: reason ? (EVENT_REASONS[reason] ?? humanise(reason).toLowerCase()) : "",
    actor: ACTOR_CAPACITIES[actorKind] ?? humanise(actorKind),
    // Caution, never negative: a suspension is a report worth reading carefully,
    // and colouring it as a finding would do with styling what the wording
    // refuses to do with words.
    tone: type === "product_suspended" ? "caution" : "neutral",
  };
}
