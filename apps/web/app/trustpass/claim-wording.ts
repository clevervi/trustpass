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
