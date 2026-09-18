/**
 * Which origins a browser may make a write request from.
 *
 * `app.use("*", cors())` is Hono's default, which is `Access-Control-Allow-Origin: *`
 * on every route including the two that write. Nobody chose that; it arrived
 * with the middleware.
 *
 * **Why it is harmless today and will not stay that way.** CORS protects a
 * user's browser from another origin using *their* credentials. There are no
 * credentials: no authentication, no cookies, no session. `curl` ignores CORS
 * entirely, so nothing about the current API is defended by it and nothing is
 * exposed by `*`.
 *
 * What changes with #141 depends on how the credential travels, and an earlier
 * version of this comment overstated it. A wildcard does not hand a token to
 * another origin:
 *
 *   Authorization: Bearer   the page has to already possess the token. CORS is
 *                           not what keeps it from having one, and `*` does not
 *                           give it one.
 *   Cookie, or anything     the browser attaches the credential by itself, so
 *   the browser attaches    any page that can reach the endpoint can act as the
 *   automatically          visitor. Here `*` is the whole problem.
 *
 * So the accurate statement is narrower: **this policy is safe only while the
 * API holds no browser-carried credential, and must not permit arbitrary
 * origins for authenticated writes once it does.** Which credential #141
 * chooses is exactly the decision least likely to come back and read this file,
 * so it is decided now, while getting it wrong costs nothing.
 *
 * The three states follow `apps/web/lib/passport-origin.ts`, which learned the
 * same lesson about a different value: an unset variable is not a permissive
 * default, it is a question nobody answered, and the honest response is to
 * refuse rather than to guess.
 */
export type CorsPolicy =
  /** Somebody named the origins. */
  | { readonly kind: "allowlist"; readonly origins: readonly string[] }
  /** Somebody said "none", explicitly. Same-origin still works. */
  | { readonly kind: "none" }
  /** Nobody said anything. Not a default — a refusal to start. */
  | { readonly kind: "unset" }
  /** Somebody asked for something this will not do. Also a refusal to start. */
  | { readonly kind: "refused"; readonly reason: string };

export const ALLOWED_ORIGINS_VARIABLE = "TRUSTPASS_ALLOWED_ORIGINS";

/**
 * Reads the policy from one environment variable.
 *
 * Absent and empty are deliberately different. An empty string is a decision
 * that no browser origin may write; an absent variable is nobody having made
 * one, and the second must not quietly become the first.
 */
export function readCorsPolicy(raw: string | undefined): CorsPolicy {
  if (raw === undefined) {
    return { kind: "unset" };
  }

  const origins = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  // A wildcard on a write route is the defect this module exists for, so it is
  // not reachable by configuration either. Refused rather than filtered out:
  // dropping it silently would leave an operator believing they had opened the
  // API while every request failed, which is the quietly-wrong outcome this
  // repository keeps replacing with a loud one.
  if (origins.includes("*")) {
    return {
      kind: "refused",
      reason: `${ALLOWED_ORIGINS_VARIABLE} contains "*". A write route never accepts every origin; name them, or set it empty to accept none.`,
    };
  }

  return origins.length === 0 ? { kind: "none" } : { kind: "allowlist", origins };
}

/**
 * The origins a cross-origin write may come from. Never `*`, whatever the
 * policy says — a wildcard here is the defect this module exists for.
 */
export function writeOrigins(policy: CorsPolicy): readonly string[] {
  return policy.kind === "allowlist" ? policy.origins : [];
}

/** What to tell an operator, in a line, at startup. */
export function describeCorsPolicy(policy: CorsPolicy): string {
  switch (policy.kind) {
    case "allowlist":
      return `write routes accept ${policy.origins.join(", ")}`;
    case "none":
      return "write routes accept no browser origin";
    case "unset":
      return `${ALLOWED_ORIGINS_VARIABLE} is not set`;
    case "refused":
      return policy.reason;
  }
}
