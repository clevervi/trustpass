import { checkSymbol, decodeSymbols, encodeSymbols, normalizeSymbols } from "./crockford-base32.js";

/**
 * A TrustPass ID that has been parsed and whose check symbol verified.
 *
 * The brand exists so that an unvalidated string cannot be passed where a
 * verified identifier is required. Construct one through `generateTrustPassId`
 * or `parseTrustPassId`; there is deliberately no cast helper.
 *
 * The marker is a named property rather than a `unique symbol` on purpose. An
 * unexported symbol cannot be referenced from outside this module, so any
 * consumer exporting a value whose type contains one fails to compile with
 * TS4023 — "has or is using name 'brand' ... but cannot be named". A named
 * property is nameable everywhere and rejects a plain string just as firmly.
 *
 * It never exists at runtime: the value is a string.
 */
export type TrustPassId = string & { readonly __trustPassId: "verified" };

const PREFIX = "TP";

/**
 * Format version. Printed labels cannot be recalled, so the only way to ever
 * change the format is to leave a marker saying which one this is.
 */
const VERSION = "1";

/** 128 bits, matching the accepted baseline for unguessable public identifiers. */
const ENTROPY_BYTES = 16;

/** ceil(128 / 5) symbols. The two leading bits are always zero. */
const BODY_LENGTH = 26;

const NORMALIZED_LENGTH = PREFIX.length + VERSION.length + BODY_LENGTH + 1;
const BODY_START = PREFIX.length + VERSION.length;
const BODY_END = BODY_START + BODY_LENGTH;

export type TrustPassIdParseError =
  | "empty"
  | "invalid_length"
  | "invalid_prefix"
  | "unsupported_version"
  | "invalid_symbol"
  | "checksum_mismatch";

export type TrustPassIdParseResult =
  | { readonly ok: true; readonly id: TrustPassId }
  | { readonly ok: false; readonly error: TrustPassIdParseError };

function format(value: bigint): TrustPassId {
  const body = encodeSymbols(value, BODY_LENGTH);
  return `${PREFIX}${VERSION}-${body}${checkSymbol(value)}` as TrustPassId;
}

/**
 * Generates a new TrustPass ID from the platform CSPRNG.
 *
 * Never derive an identifier from a counter, a timestamp or a serial: the
 * passport it addresses is publicly readable, so a guessable identifier lets
 * anyone enumerate every product in the system.
 */
export function generateTrustPassId(): TrustPassId {
  const bytes = new Uint8Array(ENTROPY_BYTES);
  crypto.getRandomValues(bytes);

  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }

  return format(value);
}

/**
 * Parses a candidate identifier, tolerating the ways a human transcribes one:
 * lower case, missing or extra separators, and the classic 1/I/l and 0/O
 * substitutions.
 *
 * A failed check symbol is reported as such rather than as "not found", so the
 * caller can tell someone they mistyped instead of telling them their product
 * is unregistered.
 */
export function parseTrustPassId(input: string): TrustPassIdParseResult {
  if (input.trim() === "") {
    return { ok: false, error: "empty" };
  }

  const normalized = normalizeSymbols(input);

  if (normalized.length !== NORMALIZED_LENGTH) {
    return { ok: false, error: "invalid_length" };
  }

  if (!normalized.startsWith(PREFIX)) {
    return { ok: false, error: "invalid_prefix" };
  }

  if (normalized.charAt(PREFIX.length) !== VERSION) {
    return { ok: false, error: "unsupported_version" };
  }

  const body = normalized.slice(BODY_START, BODY_END);
  const value = decodeSymbols(body);

  if (value === null) {
    return { ok: false, error: "invalid_symbol" };
  }

  if (normalized.charAt(BODY_END) !== checkSymbol(value)) {
    return { ok: false, error: "checksum_mismatch" };
  }

  return { ok: true, id: format(value) };
}

/** True when the input parses and its check symbol verifies. */
export function isTrustPassId(input: string): input is TrustPassId {
  return parseTrustPassId(input).ok;
}
