/**
 * What the passport page receives from the API.
 *
 * Fields that the API types as closed enums are plain strings here on purpose.
 * The API may add a claim state or a category before this page learns about it,
 * and an additive change on the server must not turn a valid passport into an
 * error page. Unknown values are rendered neutrally by the wording module.
 */
export interface PassportView {
  readonly trustpassId: string;
  readonly brand: string;
  readonly model: string;
  readonly category: string;
  readonly status: string;
  readonly serial: { readonly suffix: string; readonly hiddenCharacters: number } | null;
  readonly registeredOn: string;
  readonly issuer: {
    readonly companyName: string;
    readonly country: string;
    readonly registrationNumber: string;
    readonly verificationStatus: string;
  };
  readonly claims: readonly { readonly claim: string; readonly state: string }[];
  /**
   * What was recorded about this product, newest first.
   *
   * Optional on the type, not on the contract. An API serving a passport from
   * before this shipped omits the field, and a reader should get the passport
   * without its history rather than an error page — the same reasoning that
   * keeps every other field a plain string here.
   */
  readonly history?: readonly PassportHistoryEntry[];
}

export interface PassportHistoryEntry {
  readonly type: string;
  readonly actorKind: string;
  readonly occurredOn: string;
  readonly recordedOn: string;
  readonly reason: string | null;
}

export type PassportResult =
  | { readonly outcome: "found"; readonly passport: PassportView }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "unreadable"; readonly reason: "mistyped" | "malformed" }
  | { readonly outcome: "unavailable" };

export interface FetchPassportOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSerial(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      typeof value.suffix === "string" &&
      typeof value.hiddenCharacters === "number")
  );
}

function isIssuer(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.companyName === "string" &&
    typeof value.country === "string" &&
    typeof value.registrationNumber === "string" &&
    typeof value.verificationStatus === "string"
  );
}

function isClaims(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (claim) =>
        isRecord(claim) && typeof claim.claim === "string" && typeof claim.state === "string",
    )
  );
}

/**
 * History is checked but not required.
 *
 * Absent is fine — an older API does not serve it. Present and malformed is
 * not: a half-parsed entry would render a date or an actor as `undefined` in a
 * record a stranger is reading to decide whether to trust a product.
 */
function isHistory(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (entry) =>
          isRecord(entry) &&
          typeof entry.type === "string" &&
          typeof entry.actorKind === "string" &&
          typeof entry.occurredOn === "string" &&
          typeof entry.recordedOn === "string" &&
          (entry.reason === null || typeof entry.reason === "string"),
      ))
  );
}

/**
 * A twelve-line guard rather than a schema library: one shape, server-side only,
 * and a half-parsed body must never render as a passport with blanks in it.
 */
function isPassportView(value: unknown): value is PassportView {
  return (
    isRecord(value) &&
    typeof value.trustpassId === "string" &&
    typeof value.brand === "string" &&
    typeof value.model === "string" &&
    typeof value.category === "string" &&
    typeof value.status === "string" &&
    typeof value.registeredOn === "string" &&
    isSerial(value.serial) &&
    isIssuer(value.issuer) &&
    isClaims(value.claims) &&
    isHistory(value.history)
  );
}

function errorCodeOf(value: unknown): string | undefined {
  return isRecord(value) && typeof value.error === "string" ? value.error : undefined;
}

/**
 * Asks the API for a passport, and never throws.
 *
 * The outcome is decided by the API's error **code**, never by the HTTP status
 * alone and never by the message. The distinction that matters most: a failure to
 * reach or understand the API must come back as `unavailable`, never as
 * `not_found`. "We could not check" and "this product is not registered" are
 * different answers, and giving the second when the truth is the first tells a
 * buyer a genuine product is fake.
 *
 * That is also why a generic 404 — an API without this route, say — is
 * `unavailable`. Only the specific `passport_not_found` code means not found.
 */
export async function fetchPassport(
  trustpassId: string,
  options: FetchPassportOptions = {},
): Promise<PassportResult> {
  // Read inside the function so tests can override it. Kept as a full literal
  // member expression, which is what Next replaces.
  const baseUrl = (
    options.baseUrl ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:3001"
  ).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(`${baseUrl}/passports/${encodeURIComponent(trustpassId)}`, {
      // A suspended product must read as suspended on the next request.
      cache: "no-store",
    });

    if (response.status === 200) {
      const body: unknown = await response.json();
      return isPassportView(body)
        ? { outcome: "found", passport: body }
        : { outcome: "unavailable" };
    }

    if (response.status === 404 || response.status === 422) {
      const code = errorCodeOf(await response.json());

      if (code === "passport_not_found") return { outcome: "not_found" };
      if (code === "mistyped_trustpass_id") return { outcome: "unreadable", reason: "mistyped" };
      if (code === "malformed_trustpass_id") return { outcome: "unreadable", reason: "malformed" };
    }

    return { outcome: "unavailable" };
  } catch {
    return { outcome: "unavailable" };
  }
}
