import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The shape of a presented credential, and nothing about whether it is valid.
 *
 * ADR 0014 §3. Split from verification on purpose: parsing is pure, total, and
 * testable without a database, and the half of authentication that is easiest
 * to get subtly wrong is the half that touches no I/O at all.
 *
 *   tp.live.7f3a91c4.9mK2x…
 *      |    |        |
 *      |    |        └─ 256 bits, base64url
 *      |    └─────────── 64 bits, the indexed lookup handle, stored in clear
 *      └──────────────── environment
 */

export const TOKEN_PREFIX = "tp";

/**
 * A character base64url cannot produce, which is the entire requirement.
 *
 * The first version of this file used `_`, and roughly half of every token it
 * issued could not be parsed back — base64url's alphabet is `A-Z a-z 0-9 - _`,
 * so a secret containing the delimiter split into five parts instead of four.
 * Measured: 481 of 1000 random 32-byte secrets contain an underscore.
 *
 * It looked like an intermittent test failure. It was a format that could not
 * read itself, and a `startsWith`-shaped test would never have found it.
 */
const DELIMITER = ".";
const PARTS = 4;
const HANDLE_BYTES = 8;
const SECRET_BYTES = 32;

/** What `TRUSTPASS_ENV` may say. A token is bound to exactly one of these. */
export const ENVIRONMENTS = ["live", "staging", "dev"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export interface ParsedToken {
  readonly environment: Environment;
  readonly handle: string;
  readonly secret: string;
}

/**
 * Parses a presented value, and refuses everything else identically.
 *
 * Returns null rather than describing what was wrong. A caller that learns
 * "wrong environment" rather than "no" has learned which environments exist and
 * what they hold — the same oracle #143 removed from `/enrolments`, and there is
 * no reason to reintroduce it at the door.
 */
export function parseToken(
  presented: string | undefined,
  environment: Environment,
): ParsedToken | null {
  if (typeof presented !== "string") {
    return null;
  }

  const parts = presented.split(DELIMITER);

  // Exactly four, because a payload containing the delimiter would otherwise be
  // silently truncated at the first one and compared as a shorter value. The
  // delimiter is chosen so the payload cannot contain it; this is the assertion
  // that the two decisions still agree.
  if (parts.length !== PARTS) {
    return null;
  }

  const [prefix, env, handle, secret] = parts;

  if (prefix !== TOKEN_PREFIX || env !== environment) {
    return null;
  }

  // Lengths, so a handle of the wrong size never reaches an indexed lookup and
  // a secret of the wrong size never reaches a comparison that requires equal
  // lengths to be constant-time.
  if (
    handle?.length !== base64urlLength(HANDLE_BYTES) ||
    secret?.length !== base64urlLength(SECRET_BYTES)
  ) {
    return null;
  }

  if (!isBase64url(handle) || !isBase64url(secret)) {
    return null;
  }

  return { environment: env as Environment, handle, secret };
}

function base64urlLength(bytes: number): number {
  return Math.ceil((bytes * 4) / 3);
}

function isBase64url(value: string): boolean {
  // Character-by-character rather than a pattern. The inputs are short and
  // fixed-length, and this repository has lost time to a regular expression
  // that behaved differently once it had been through an escaping layer.
  for (const character of value) {
    const ok =
      (character >= "A" && character <= "Z") ||
      (character >= "a" && character <= "z") ||
      (character >= "0" && character <= "9") ||
      character === "-" ||
      character === "_";

    if (!ok) {
      return false;
    }
  }

  return value.length > 0;
}

/** What is stored, and the only representation of a secret that ever is. */
export function digestOf(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

/**
 * Compares two digests without leaking where they first differ.
 *
 * Both are 32 bytes by construction, which is what `timingSafeEqual` requires —
 * and the length check is here rather than assumed, because the function throws
 * on a mismatch and a thrown error inside a verifier is an answer.
 */
export function digestsMatch(presented: Buffer, stored: Buffer): boolean {
  if (presented.length !== stored.length) {
    return false;
  }

  return timingSafeEqual(presented, stored);
}

export interface IssuedCredential {
  /** Shown once, stored nowhere. */
  readonly token: string;
  readonly handle: string;
  readonly digest: Buffer;
}

/**
 * Mints one. The secret exists in this process and in the operator's terminal,
 * and nowhere else — ADR 0014 §8.
 */
export function issueToken(environment: Environment): IssuedCredential {
  const handle = randomBytes(HANDLE_BYTES).toString("base64url");
  const secret = randomBytes(SECRET_BYTES).toString("base64url");

  return {
    token: [TOKEN_PREFIX, environment, handle, secret].join(DELIMITER),
    handle,
    digest: digestOf(secret),
  };
}
