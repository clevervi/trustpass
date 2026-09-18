/**
 * What happens to a `Read`, and why.
 *
 * Every decision this module can reach ends in one of two places: the read
 * proceeds untouched, or it is denied and Claude is handed a local summary
 * instead. There is no third outcome, and there is no path that fails in a way
 * that stops work — every error, every missing file, every unparseable input
 * returns `passthrough`.
 *
 * The functions here take their dependencies as arguments rather than importing
 * them. That is not ceremony: it is what lets the tests drive a 429, a timeout,
 * a corrupt policy file and a symlink pointing at a secret without a network,
 * an API key, or a Gemini that exists.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Never leaves this machine. Hardcoded, and not from a file. */
export const S0 = "S0";
/** Claude reads it directly. The meaning of the product lives here. */
export const S1 = "S1";
/** May be delegated. */
export const S2 = "S2";
/** Delegation is the point — bulk, repetitive, low-meaning. */
export const S3 = "S3";

/**
 * The denylist that a pull request cannot empty.
 *
 * `sensitive-paths.txt` exists and may add to this. It may not remove from it,
 * and it is not consulted at all for these. The reason is the argument TP-161
 * made about triggers: a guard the attacker can disable is not a guard, and a
 * denylist living in the repository is one commit away from being a shorter
 * denylist. Nothing about "the repo is trusted" survives the case where the
 * thing being read is the thing that was just tampered with.
 *
 * Matched against the **resolved** path, lowercased, with forward slashes.
 */
const S0_PATTERNS = [
  /(^|\/)\.env($|\.|\/)/,
  /(^|\/)\.envrc$/,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /\.jks$/,
  /\.keystore$/,
  /\.ppk$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)($|\.)/,
  /(^|\/)\.ssh\//,
  /(^|\/)\.aws\//,
  /(^|\/)\.gcp\//,
  /(^|\/)\.azure\//,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.pgpass$/,
  /(^|\/)credentials?($|\.|\/)/,
  /(^|\/)secrets?($|\.|\/)/,
  /(^|\/)service-account.*\.json$/,
  /\.(crt|cer|der)$/,
  /(^|\/)\.git\//,
];

/**
 * Claude-only by default. These are where the product's meaning is decided, and
 * a summary of a migration is a summary of a guarantee.
 */
const S1_PATTERNS = [
  /^packages\/db\/drizzle\//,
  /^packages\/db\/src\/schema\//,
  /^docs\/adr\//,
  /(^|\/)(auth|authz|authorization|security|crypto|session|token)(\/|\.|-)/,
  /(^|\/)connection-privileges/,
  /(^|\/)least-privilege/,
  /(^|\/)provision-roles/,
  /^CONTRIBUTING\.md$/,
  /^SECURITY\.md$/,
];

/** Bulk by nature. Reading one of these in full is usually waste. */
const S3_PATTERNS = [/\.test\.(ts|tsx|mjs|js)$/, /\.spec\.(ts|tsx|mjs|js)$/, /(^|\/)fixtures?\//];

export const ROUTER_VERSION = "1";

/** Normalises to the form the patterns above are written against. */
function normalise(path) {
  return path.split(sep).join("/").toLowerCase();
}

/**
 * The real file on disk, symlinks followed.
 *
 * `safe/notes.md` may be a symlink to `.env`, and classifying the name rather
 * than the target is how a denylist gets walked around without breaking a
 * single rule. Returns null when the path cannot be resolved, which is itself a
 * reason not to delegate.
 */
export function resolveReal(path) {
  try {
    return realpathSync(isAbsolute(path) ? path : resolve(path));
  } catch {
    return null;
  }
}

/**
 * Reads the optional policy file, and fails closed towards Gemini when it
 * cannot.
 *
 * A missing, unreadable or malformed policy is not a reason to delegate more
 * freely. It is a reason to delegate nothing until somebody looks at it —
 * Claude keeps working either way, which is what makes fail-closed affordable
 * here.
 */
export function loadPolicy(readFile, policyPath) {
  let raw;

  try {
    raw = readFile(policyPath);
  } catch {
    return { ok: false, reason: "sensitive-paths.txt is missing or unreadable", patterns: [] };
  }

  if (typeof raw !== "string") {
    return { ok: false, reason: "sensitive-paths.txt did not read as text", patterns: [] };
  }

  const patterns = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    try {
      // Treated as a substring rule, not a regex. A policy file that can
      // define a regex can define a catastrophically backtracking one, and
      // this project already lost 500 seconds to that once.
      patterns.push(trimmed.toLowerCase());
    } catch {
      return {
        ok: false,
        reason: `sensitive-paths.txt has an unusable line: ${trimmed}`,
        patterns: [],
      };
    }
  }

  return { ok: true, reason: null, patterns };
}

/**
 * Where a file sits, given its real path.
 *
 * Order matters and is not alphabetical: S0 is checked first and cannot be
 * overridden by anything, then the policy file, then S1.
 */
export function classify(realPath, { repoRoot, policy }) {
  const normalisedAbsolute = normalise(realPath);

  for (const pattern of S0_PATTERNS) {
    if (pattern.test(normalisedAbsolute)) {
      return { level: S0, reason: `matches a hardcoded never-transmit rule (${pattern})` };
    }
  }

  const relativePath = relative(repoRoot, realPath);

  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return { level: S0, reason: "outside the repository" };
  }

  const normalisedRelative = normalise(relativePath);

  if (!policy.ok) {
    return { level: S1, reason: policy.reason };
  }

  for (const needle of policy.patterns) {
    if (normalisedRelative.includes(needle)) {
      return { level: S1, reason: `listed in sensitive-paths.txt (${needle})` };
    }
  }

  for (const pattern of S1_PATTERNS) {
    if (pattern.test(normalisedRelative)) {
      return { level: S1, reason: `the product's meaning is decided here (${pattern})` };
    }
  }

  for (const pattern of S3_PATTERNS) {
    if (pattern.test(normalisedRelative)) {
      return { level: S3, reason: "bulk by nature" };
    }
  }

  return { level: S2, reason: "ordinary source" };
}

export const DEFAULTS = {
  /**
   * A read this small is Claude checking specific lines, which is exactly the
   * behaviour a summary is supposed to produce. Delegating it would be
   * answering a precise question with a vague one, and would loop.
   */
  smallReadLines: 180,
  /**
   * Below this a full read costs less than the round trip to avoid it.
   *
   * 400 rather than the 600 this was first written with, because 600 was a
   * number and not a measurement. Counted against the repository it runs in:
   *
   *   >= 200 lines   30 files
   *   >= 300 lines   12 files
   *   >= 400 lines    7 files
   *   >= 500 lines    3 files
   *   >= 600 lines    0 files
   *
   * At 600 this router would never once have fired here. At 400 it has seven
   * files to work with, which is a small number and the honest one: on a
   * codebase this size the mechanism matters more than the saving, and the
   * saving arrives when the codebase does.
   */
  largeFileLines: 400,
  largeFileBytes: 24_000,
};

/**
 * The decision, with no I/O of its own.
 *
 * Returns `{ action: "passthrough" }` or `{ action: "delegate", ... }`. It
 * never returns "deny" directly, because whether the delegation succeeds
 * depends on a cache lookup and possibly a network call — and if either fails,
 * the answer has to become passthrough again.
 */
export function decideRoute(request, { repoRoot, policy, sizeOf, config = DEFAULTS }) {
  if (request.toolName !== "Read") {
    return { action: "passthrough", reason: "not a Read" };
  }

  if (typeof request.filePath !== "string" || request.filePath.length === 0) {
    return { action: "passthrough", reason: "no file path in the payload" };
  }

  if (
    typeof request.limit === "number" &&
    request.limit > 0 &&
    request.limit <= config.smallReadLines
  ) {
    return { action: "passthrough", reason: `bounded read of ${request.limit} lines` };
  }

  const realPath = resolveReal(request.filePath);

  if (!realPath) {
    return { action: "passthrough", reason: "path does not resolve" };
  }

  const { level, reason } = classify(realPath, { repoRoot, policy });

  if (level === S0 || level === S1) {
    return { action: "passthrough", reason: `${level}: ${reason}`, level, realPath };
  }

  const size = sizeOf(realPath);

  if (!size) {
    return { action: "passthrough", reason: "size unknown", level, realPath };
  }

  if (size.lines < config.largeFileLines && size.bytes < config.largeFileBytes) {
    return {
      action: "passthrough",
      reason: `small enough to read directly (${size.lines} lines)`,
      level,
      realPath,
    };
  }

  return { action: "delegate", level, realPath, size, reason: `${level}: ${reason}` };
}
